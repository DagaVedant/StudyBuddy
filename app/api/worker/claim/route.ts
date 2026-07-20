import { NextResponse } from 'next/server'
import { z } from 'zod'

import type { Db } from '@/lib/dashboard/queries'
import { db } from '@/lib/db'
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

  return NextResponse.json({
    job: {
      id: job.id,
      worksheetId: job.worksheetId,
      stage: job.stage,
      attemptCount: job.attemptCount,
      checkpoint: job.checkpoint,
    },
    pages: await pagesForJob(client, job.worksheetId),
  })
}
