import { and, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { userAiCredentials, worksheets } from '@/lib/db/schema'
import { claimJob, queueDepth } from '@/lib/queue'
import { pagesForJob } from '@/lib/worker/ingest'

/**
 * The Tier C equivalent of `POST /api/worker/claim`.
 *
 * Same queue, same claim, different worker: this one is the student's own tab,
 * which is the only thing that can reach the Ollama on their machine
 * (spec.md:184). The differences from the operator's endpoint are all
 * consequences of the worker being untrusted and singular rather than trusted
 * and shared:
 *
 * - It authenticates a session, not `WORKER_API_TOKEN`.
 * - It claims only this user's own jobs. The response carries the worksheet's
 *   page text, so an unfiltered claim would hand one student another's paper.
 * - It does not reap abandoned jobs. The operator's claim is the queue's only
 *   regular heartbeat and carries the reaper for that reason; this one runs
 *   whenever somebody happens to have a tab open, which is not a schedule, and
 *   the cron already does it (app/api/cron/drain-server-queue/route.ts).
 */
export async function POST() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const userId = session.user.id

  // Nothing to do here without a configured Ollama, and saying so is more
  // useful than an empty queue: a tab polling forever against an account whose
  // credential was deleted mid-job would otherwise look identical to one with
  // no work waiting.
  const [credential] = await db
    .select({
      baseUrl: userAiCredentials.ollamaBaseUrl,
      visionModel: userAiCredentials.visionModelName,
      textModel: userAiCredentials.modelName,
    })
    .from(userAiCredentials)
    .where(
      and(eq(userAiCredentials.userId, userId), eq(userAiCredentials.provider, 'ollama')),
    )
    .limit(1)

  if (!credential?.baseUrl) {
    return NextResponse.json({ error: 'No Ollama is configured.' }, { status: 409 })
  }

  const job = await claimJob(db, 'browser', null, new Date(), userId)

  if (!job) {
    return NextResponse.json({ job: null, depth: await queueDepth(db, 'browser') })
  }

  const [worksheet] = await db
    .select({
      title: worksheets.title,
      expectedQuestionCount: worksheets.expectedQuestionCount,
    })
    .from(worksheets)
    .where(eq(worksheets.id, job.worksheetId))
    .limit(1)

  return NextResponse.json({
    job: {
      id: job.id,
      worksheetId: job.worksheetId,
      stage: job.stage,
      attemptCount: job.attemptCount,
      title: worksheet?.title ?? null,
      expectedQuestionCount: worksheet?.expectedQuestionCount ?? null,
      checkpoint: job.checkpoint,
    },
    // The whole page set, `ocrText` included, which is what the operator's
    // worker also receives. It is the heaviest thing this route returns and it
    // is not avoidable per page: the extraction prompt carries the text of the
    // pages either side of the one being read, so a question that ran over the
    // fold can be read whole (`seamAround`). Fetching one page at a time would
    // mean fetching most of them twice.
    pages: await pagesForJob(db, job.worksheetId),
    ollama: {
      baseUrl: credential.baseUrl,
      // The same defaults the credential route applies on save, repeated
      // because a row written before those defaults existed can still hold
      // nulls, and the tab has no other source for them.
      visionModel: credential.visionModel ?? 'qwen2.5vl:7b',
      textModel: credential.textModel ?? 'qwen2.5vl:7b',
    },
  })
}
