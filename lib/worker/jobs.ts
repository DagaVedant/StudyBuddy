import {eq} from 'drizzle-orm'

import {runExtraction, runRepairPasses} from '@/lib/worker/pipeline'
import {worksheets} from '@/lib/schema'
import {recordUntagged, UNTAGGED_REASON} from '@/lib/worker/apply'
import {
  type ClaimedJob,
  claimJob,
  completeJob,
  enqueueJob,
  failJob,
  transitionWorksheet,
} from '@/lib/queue'
import {deriveSolutions} from '@/lib/worker/solutions'
import {classifyWorksheet, EmbeddingUnavailableError} from '@/lib/taxonomy'
import {type AIProvider} from '@/lib/ai/types'
import {type Db} from '@/lib/db'
import {resolveProvider} from '@/lib/ai/resolve'

const SOLVE_BATCH = 25

async function runSolvingJob(
  db: Db,
  provider: AIProvider,
  job: {id: string; worksheetId: string; userId: string},
) {
  try {
    const progress = await deriveSolutions(db, provider, job.worksheetId, SOLVE_BATCH)

    await completeJob(db, job.id)

    const attempted = progress.solved + progress.refused + progress.failed

    let line =
      '[server-job] solved ' +
      progress.solved +
      ' of ' +
      attempted +
      ' on ' +
      job.worksheetId

    if (progress.promoted > 0) {
      line = line + ', ' + progress.promoted + ' promoted to the answer'
    }

    if (progress.refused > 0) {
      line = line + ', ' + progress.refused + ' declined'
    }

    console.log(line)

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
    const outcome = await failJob(db, job.id, (error as Error).message)

    let where = '[server-job] solving failed on ' + job.worksheetId
    if (outcome.permanent) where = where + ' (permanently)'

    console.error(where + ':', (error as Error).message)
  }
}

async function runOneServerJob(db: Db, job: ClaimedJob) {
  const resolved = await resolveProvider(db, job.userId)
  const provider = resolved.provider

  if (resolved.executor !== 'server') {
    await failJob(db, job.id, 'No model is configured for this account anymore.', true)

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
      'The server runner has no ' + job.stage + ' stage. Nothing should have enqueued this.',
      true,
    )

    return
  }

  try {
    await runExtraction(db, provider, job)

    await runRepairPasses(db, job.worksheetId)

    const [worksheet] = await db
      .select({subjectHint: worksheets.subjectHint})
      .from(worksheets)
      .where(eq(worksheets.id, job.worksheetId))
      .limit(1)

    let subjectHint = null
    if (worksheet) subjectHint = worksheet.subjectHint

    try {
      const counts = await classifyWorksheet(db, provider, job.worksheetId, subjectHint)

      let line =
        '[server-job] classified ' + counts.classified + ' question(s) on ' + job.worksheetId

      if (counts.coarse > 0) line = line + ', ' + counts.coarse + ' raised a topic proposal'
      if (counts.failed > 0) line = line + ', ' + counts.failed + ' failed'

      console.log(line)
    } catch (error) {
      await recordUntagged(db, job.worksheetId, UNTAGGED_REASON.classifierFailed)

      if (error instanceof EmbeddingUnavailableError) {
        console.error(
          '[server-job] the embedding model will not load on this host: ' +
            error.message +
            '. Worksheet ' +
            job.worksheetId +
            ' is extracted but untagged, and so is every other one until it loads. ' +
            'The student can still sort it from the dashboard.',
        )
      } else {
        console.error(
          '[server-job] classification failed on ' + job.worksheetId + ':',
          (error as Error).message,
        )
      }
    }

    await transitionWorksheet(db, job.worksheetId, ['queued', 'processing'], {
      status: 'awaiting_review',
    })

    await completeJob(db, job.id)

    await enqueueJob(db, {
      worksheetId: job.worksheetId,
      userId: job.userId,
      stage: 'answer_key',
      executor: 'server',
      priority: 'low',
    })
  } catch (error) {
    const outcome = await failJob(db, job.id, (error as Error).message)

    if (outcome.permanent) {
      await transitionWorksheet(db, job.worksheetId, ['queued', 'processing'], {
        status: 'failed',
      })
    }
  }
}

export async function drainServerQueue(db: Db, limit = 1) {
  for (let i = 0; i < limit; i++) {
    let job

    try {
      job = await claimJob(db, 'server')
    } catch (error) {
      console.error('[server-job] could not claim:', (error as Error).message)
      return
    }

    if (!job) return

    await runOneServerJob(db, job)
  }
}
