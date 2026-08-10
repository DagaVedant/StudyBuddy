import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { db } from '@/lib/db'
import { worksheets } from '@/lib/db/schema'
import { claimJob, heartbeat, queueDepth, reapAbandonedJobs } from '@/lib/queue'
import { authenticateWorker } from '@/lib/worker/auth'
import { applyPermanentFailure } from '@/lib/worker/fail'
import { pagesForJob } from '@/lib/worker/ingest'

const claimSchema = z.object({
  workerName: z.string().trim().min(1).max(100),
  modelName: z.string().trim().max(200).nullish(),
  // How many jobs the worker is already running. Only the worker knows; this
  // route used to write 0 and then 1 regardless, which made the column say
  // "idle" for a machine part-way through a 114 question paper. Optional so an
  // older worker binary still claims successfully, at its previous accuracy.
  jobsInFlight: z.number().int().min(0).max(64).default(0),
})

export async function POST(request: Request) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status })
  }

  const parsed = claimSchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const { workerName, modelName, jobsInFlight } = parsed.data

  const workerId = await heartbeat(db, workerName, modelName ?? null, jobsInFlight)

  // The queue's only regular heartbeat, so it is where the reaper lives. A
  // worker that dies on its third claim leaves a job past the retry ceiling and
  // still marked claimed, which nothing else will ever touch: unclaimable, and
  // only a worker marks jobs failed. The worksheet sat at "Queued" forever and
  // the trial credit was never refunded.
  //
  // Before the claim, so a job the student is about to be told about is not one
  // that has already been abandoned.
  for (const abandoned of await reapAbandonedJobs(db)) {
    console.log(
      `[queue] reaped abandoned ${abandoned.stage} job ${abandoned.id} on ` +
        `worksheet ${abandoned.worksheetId}`,
    )
    // The same path a reported failure takes, so a job that dies silently and
    // one that dies loudly leave the account in the same state.
    await applyPermanentFailure(db, abandoned)
  }

  const job = await claimJob(db, 'operator_gpu', workerId)

  if (!job) {
    const depth = await queueDepth(db, 'operator_gpu')
    return NextResponse.json({ job: null, depth })
  }

  await heartbeat(db, workerName, modelName ?? null, jobsInFlight + 1)

  // Sent so the worker can size its own concurrency: how much of the paper
  // there is decides whether reading pages in parallel is worth the memory.
  const [worksheet] = await db
    .select({ expectedQuestionCount: worksheets.expectedQuestionCount })
    .from(worksheets)
    .where(eq(worksheets.id, job.worksheetId))
    .limit(1)

  return NextResponse.json({
    job: {
      id: job.id,
      worksheetId: job.worksheetId,
      stage: job.stage,
      attemptCount: job.attemptCount,
      expectedQuestionCount: worksheet?.expectedQuestionCount ?? null,
      checkpoint: job.checkpoint,
    },
    pages: await pagesForJob(db, job.worksheetId),
  })
}
