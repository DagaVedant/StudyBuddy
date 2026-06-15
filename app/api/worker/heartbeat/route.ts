import { NextResponse } from 'next/server'
import { z } from 'zod'

import type { Db } from '@/lib/dashboard/queries'
import { db } from '@/lib/db'
import { heartbeat, markWorkerOffline, queueDepth } from '@/lib/queue'
import { authenticateWorker } from '@/lib/worker/auth'

const schema = z.object({
  workerName: z.string().trim().min(1).max(100),
  modelName: z.string().trim().max(200).nullish(),
  jobsInFlight: z.number().int().min(0).max(64).default(0),
  shuttingDown: z.boolean().default(false),
})

export async function POST(request: Request) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status })
  }

  const parsed = schema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const client = db as unknown as Db
  const { workerName, modelName, jobsInFlight, shuttingDown } = parsed.data

  if (shuttingDown) {
    await markWorkerOffline(client, workerName)
    return NextResponse.json({ ok: true })
  }

  await heartbeat(client, workerName, modelName ?? null, jobsInFlight)

  return NextResponse.json({
    ok: true,
    depth: await queueDepth(client, 'operator_gpu'),
  })
}
