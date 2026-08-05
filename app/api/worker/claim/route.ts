import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import type { Db } from '@/lib/dashboard/queries'
import { db } from '@/lib/db'
import { worksheets } from '@/lib/db/schema'
import { claimJob, heartbeat, queueDepth } from '@/lib/queue'
import { authenticateWorker } from '@/lib/worker/auth'
import { pagesForJob } from '@/lib/worker/ingest'

const claimSchema = z.object({
  workerName: z.string().trim().min(1).max(100),
  modelName: z.string().trim().max(200).nullish(),
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

  const client = db as unknown as Db
  const { workerName, modelName } = parsed.data

  const workerId = await heartbeat(client, workerName, modelName ?? null, 0)
  const job = await claimJob(client, 'operator_gpu', workerId)

  if (!job) {
    const depth = await queueDepth(client, 'operator_gpu')
    return NextResponse.json({ job: null, depth })
  }

  await heartbeat(client, workerName, modelName ?? null, 1)

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
    pages: await pagesForJob(client, job.worksheetId),
  })
}
