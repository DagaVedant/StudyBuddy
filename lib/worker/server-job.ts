import { eq } from 'drizzle-orm'

import { resolveProvider, type ResolvedProvider } from '@/lib/ai/resolve'
import { EmbeddingUnavailableError, classifyWorksheet } from '@/lib/classify'
import type { Db } from '@/lib/db/types'
import { worksheets } from '@/lib/db/schema'
import { claimJob, completeJob, enqueueJob, failJob } from '@/lib/queue'
import { transitionWorksheet } from '@/lib/queue'
import { runExtraction } from '@/lib/worker/ingest'
import { runRepairPasses } from '@/lib/worker/pipeline'
import { UNTAGGED_REASON, recordUntagged } from '@/lib/worker/status'
import { deriveSolutions } from '@/lib/worker/solutions'

type Resolver = (db: Db, userId: string) => Promise<ResolvedProvider>

const SOLVE_BATCH = 25

export async function drainServerQueue(
  db: Db,
  limit = 1,
  resolve: Resolver = resolveProvider,
): Promise<void> {
  for (let i = 0; i < limit; i += 1) {
    let job
    try {
      job = await claimJob(db, 'server')
    } catch (error) {
      console.error('[server-job] could not claim:', (error as Error).message)
      return
    }

    if (!job) return

    await runOneServerJob(db, job, resolve)
  }
}

async function runOneServerJob(
  db: Db,
  job: {
    id: string
    worksheetId: string
    userId: string
    stage: 'extract' | 'answer_key' | 'classify' | 'explain'
    checkpoint: Record<string, unknown> | null
  },
  resolve: Resolver,
): Promise<void> {
  const { provider, executor } = await resolve(db, job.userId)

  if (executor !== 'server') {
    await failJob(
      db,
      job.id,
      'No cloud API key is configured for this account anymore.',
      true,
    )
    await transitionWorksheet(db, job.worksheetId, ['queued', 'processing'], {
      status: 'failed',
    })
    return
  }

  if (job.stage === 'answer_key') {
    await runSolvingJob(db, provider, job)
    return
  }

  if (job.stage !== 'extract') {
    await failJob(
      db,
      job.id,
      `The server runner has no ${job.stage} stage. Nothing should have enqueued this.`,
      true,
    )
    return
  }

  try {
    await runExtraction(db, provider, job)

    await runRepairPasses(db, job.worksheetId)

    const [worksheet] = await db
      .select({ subjectHint: worksheets.subjectHint })
      .from(worksheets)
      .where(eq(worksheets.id, job.worksheetId))
      .limit(1)

    try {
      const { classified, coarse, failed } = await classifyWorksheet(
        db,
        provider,
        job.worksheetId,
        worksheet?.subjectHint,
      )

      console.log(
        `[server-job] classified ${classified} question(s) on ${job.worksheetId}` +
          `${coarse > 0 ? `, ${coarse} raised a topic proposal` : ''}` +
          `${failed > 0 ? `, ${failed} failed` : ''}`,
      )
    } catch (error) {
      if (error instanceof EmbeddingUnavailableError) {
        await handOverClassification(db, job)

        console.error(
          `[server-job] the embedding model will not load on this host: ${error.message}. ` +
            `Worksheet ${job.worksheetId} is extracted but untagged, and so is every ` +
            `other one until it loads. Sorting is queued for the operator GPU, and ` +
            `the student can still do it in their browser.`,
        )
      } else {
        await recordUntagged(db, job.worksheetId, UNTAGGED_REASON.classifierFailed)

        console.error(
          `[server-job] classification failed on ${job.worksheetId}:`,
          (error as Error).message,
        )
      }
    }

    const delivered = await transitionWorksheet(
      db,
      job.worksheetId,
      ['queued', 'processing'],
      { status: 'awaiting_review' },
    )

    await completeJob(db, job.id)

    if (delivered) {
    }

    await enqueueJob(db, {
      worksheetId: job.worksheetId,
      userId: job.userId,
      stage: 'answer_key',
      executor: 'server',
      priority: 'low',
    })
  } catch (error) {
    const { permanent } = await failJob(db, job.id, (error as Error).message)
    if (permanent) {
      await transitionWorksheet(db, job.worksheetId, ['queued', 'processing'], {
        status: 'failed',
      })
    }
  }
}

async function handOverClassification(
  db: Db,
  job: { worksheetId: string; userId: string },
): Promise<void> {
  await recordUntagged(db, job.worksheetId, UNTAGGED_REASON.workerQueued)

  await enqueueJob(db, {
    worksheetId: job.worksheetId,
    userId: job.userId,
    stage: 'classify',
    executor: 'operator_gpu',
    priority: 'low',
  })
}

async function runSolvingJob(
  db: Db,
  provider: Awaited<ReturnType<Resolver>>['provider'],
  job: { id: string; worksheetId: string; userId: string },
): Promise<void> {
  try {
    const progress = await deriveSolutions(db, provider, job.worksheetId, {
      limit: SOLVE_BATCH,
    })

    await completeJob(db, job.id)

    const attempted = progress.solved + progress.refused + progress.failed

    console.log(
      `[server-job] solved ${progress.solved} of ${attempted} on ${job.worksheetId}` +
        `${progress.promoted > 0 ? `, ${progress.promoted} promoted to the answer` : ''}` +
        `${progress.refused > 0 ? `, ${progress.refused} declined` : ''}`,
    )

    if (attempted >= SOLVE_BATCH && progress.solved + progress.refused > 0) {
      await enqueueJob(db, {
        worksheetId: job.worksheetId,
        userId: job.userId,
        stage: 'answer_key',
        executor: 'server',
        priority: 'low',
      })
    }
  } catch (error) {
    const { permanent } = await failJob(db, job.id, (error as Error).message)

    console.error(
      `[server-job] solving failed on ${job.worksheetId}` +
        `${permanent ? ' (permanently)' : ''}:`,
      (error as Error).message,
    )
  }
}
