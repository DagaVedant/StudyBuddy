import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Db } from '@/lib/dashboard/queries'
import { processingJobs } from '@/lib/db/schema'
import {
  CLAIM_TTL_MS,
  MAX_ATTEMPTS,
  checkpointJob,
  claimJob,
  completeJob,
  enqueueJob,
  failJob,
  heartbeat,
  queueDepth,
  workerStatus,
} from '@/lib/queue'

import { createTestDb, type TestDb } from '../helpers/db'
import { makeUser, makeWorksheet } from '../helpers/factories'

let db: TestDb
let close: () => Promise<void>
let userId: string
let worksheetId: string

beforeAll(async () => {
  const harness = await createTestDb()
  db = harness.db
  close = harness.close
  userId = await makeUser(db)
  worksheetId = await makeWorksheet(db, userId)
})

afterAll(async () => {
  await close()
})

async function drain(executor: 'server' | 'operator_gpu' = 'operator_gpu') {
  while (await claimJob(db as Db, executor)) {
  }
  await db.delete(processingJobs)
}

describe('claimJob', () => {
  it('returns null on an empty queue', async () => {
    await drain()
    expect(await claimJob(db as Db, 'operator_gpu')).toBeNull()
  })

  it('never hands the same job to two workers', async () => {
    await drain()
    await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })

    const first = await claimJob(db as Db, 'operator_gpu')
    const second = await claimJob(db as Db, 'operator_gpu')

    expect(first).not.toBeNull()
    expect(second).toBeNull()
  })

  it('only claims jobs for its own executor', async () => {
    await drain()
    await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'server',
    })

    expect(await claimJob(db as Db, 'operator_gpu')).toBeNull()
    expect(await claimJob(db as Db, 'server')).not.toBeNull()
  })

  it('serves high priority before normal before low', async () => {
    await drain()

    for (const priority of ['low', 'normal', 'high'] as const) {
      await enqueueJob(db as Db, {
        worksheetId,
        userId,
        stage: 'extract',
        executor: 'operator_gpu',
        priority,
      })
    }

    const order: string[] = []
    for (let i = 0; i < 3; i += 1) {
      const job = await claimJob(db as Db, 'operator_gpu')
      const [row] = await db
        .select({ priority: processingJobs.priority })
        .from(processingJobs)
        .where(eq(processingJobs.id, job!.id))
      order.push(row.priority)
    }

    expect(order).toEqual(['high', 'normal', 'low'])
  })

  it('breaks priority ties by age', async () => {
    await drain()

    const first = await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })

    expect((await claimJob(db as Db, 'operator_gpu'))?.id).toBe(first)
  })

  it('reclaims a job abandoned by a dead worker', async () => {
    await drain()
    const jobId = await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })

    const claimed = await claimJob(db as Db, 'operator_gpu')
    expect(claimed?.id).toBe(jobId)
    expect(await claimJob(db as Db, 'operator_gpu')).toBeNull()

    // The worker died mid-job; its claim ages out.
    const later = new Date(Date.now() + CLAIM_TTL_MS + 60_000)
    const reclaimed = await claimJob(db as Db, 'operator_gpu', null, later)

    expect(reclaimed?.id).toBe(jobId)
    expect(reclaimed?.attemptCount).toBe(2)
  })

  it('stops reclaiming after the attempt cap', async () => {
    await drain()
    await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      const later = new Date(Date.now() + (CLAIM_TTL_MS + 60_000) * (i + 1))
      const job = await claimJob(db as Db, 'operator_gpu', null, later)
      expect(job, `attempt ${i + 1} should be claimable`).not.toBeNull()
    }

    const beyond = new Date(Date.now() + (CLAIM_TTL_MS + 60_000) * 10)
    expect(await claimJob(db as Db, 'operator_gpu', null, beyond)).toBeNull()
  })
})

describe('failJob', () => {
  it('requeues a job that still has attempts left', async () => {
    await drain()
    await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })

    const job = await claimJob(db as Db, 'operator_gpu')
    const { permanent } = await failJob(db as Db, job!.id, 'model timed out')

    expect(permanent).toBe(false)
    // Immediately claimable again — no waiting for the claim to age out.
    expect(await claimJob(db as Db, 'operator_gpu')).not.toBeNull()
  })

  it('reports a permanent failure at the attempt cap so quota can be refunded', async () => {
    await drain()
    await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })

    let permanent = false
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      const job = await claimJob(db as Db, 'operator_gpu')
      expect(job).not.toBeNull()
      permanent = (await failJob(db as Db, job!.id, 'boom')).permanent
    }

    expect(permanent).toBe(true)

    const [row] = await db.select().from(processingJobs).limit(1)
    expect(row.status).toBe('failed')
    expect(row.error).toBe('boom')
  })
})

describe('checkpointJob', () => {
  it('stores resumable progress and clamps it', async () => {
    await drain()
    await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })
    const job = await claimJob(db as Db, 'operator_gpu')

    await checkpointJob(db as Db, job!.id, 5, { lastPage: 3 })

    const [row] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, job!.id))

    expect(row.progress).toBe(1)
    expect(row.checkpoint).toEqual({ lastPage: 3 })
    expect(row.status).toBe('running')
  })

  it('hands the checkpoint back to whoever reclaims the job', async () => {
    await drain()
    await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })

    const job = await claimJob(db as Db, 'operator_gpu')
    await checkpointJob(db as Db, job!.id, 0.4, { lastPage: 7 })

    const later = new Date(Date.now() + CLAIM_TTL_MS + 60_000)
    const reclaimed = await claimJob(db as Db, 'operator_gpu', null, later)

    expect(reclaimed?.checkpoint).toEqual({ lastPage: 7 })
  })
})

describe('queueDepth', () => {
  it('counts pending and running separately', async () => {
    await drain()
    for (let i = 0; i < 3; i += 1) {
      await enqueueJob(db as Db, {
        worksheetId,
        userId,
        stage: 'extract',
        executor: 'operator_gpu',
      })
    }

    await claimJob(db as Db, 'operator_gpu')

    const depth = await queueDepth(db as Db, 'operator_gpu')
    expect(depth.pending).toBe(2)
    expect(depth.running).toBe(1)
    expect(depth.oldestPendingAt).toBeInstanceOf(Date)
  })
})

describe('worker heartbeat', () => {
  it('reports online for a fresh heartbeat', async () => {
    await heartbeat(db as Db, 'local-5080', 'qwen2.5vl:7b', 1)
    const status = await workerStatus(db as Db)

    expect(status.online).toBe(true)
    expect(status.modelName).toBe('qwen2.5vl:7b')
  })

  it('reports offline once the heartbeat goes stale', async () => {
    await heartbeat(db as Db, 'local-5080', 'qwen2.5vl:7b')
    const muchLater = new Date(Date.now() + 10 * 60_000)

    // The operator's machine went to sleep; jobs queue rather than fail.
    expect((await workerStatus(db as Db, muchLater)).online).toBe(false)
  })

  it('upserts on name rather than creating duplicates', async () => {
    await heartbeat(db as Db, 'local-5080', 'a')
    await heartbeat(db as Db, 'local-5080', 'b')

    const status = await workerStatus(db as Db)
    expect(status.modelName).toBe('b')
  })
})

describe('completeJob', () => {
  it('takes the job out of circulation', async () => {
    await drain()
    await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })

    const job = await claimJob(db as Db, 'operator_gpu')
    await completeJob(db as Db, job!.id)

    const later = new Date(Date.now() + CLAIM_TTL_MS * 10)
    expect(await claimJob(db as Db, 'operator_gpu', null, later)).toBeNull()
  })
})
