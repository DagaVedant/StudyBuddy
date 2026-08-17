import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '@/lib/db/types'
import { gpuWorkers, processingJobs, worksheets } from '@/lib/db/schema'
import {
  CLAIM_TTL_MS,
  MAX_ATTEMPTS,
  MAX_IN_FLIGHT_EXTRACTS,
  cancelJob,
  checkpointJob,
  claimJob,
  completeJob,
  enqueueJob,
  failJob,
  heartbeat,
  listActionableJobs,
  markWorkerOffline,
  inFlightExtractCount,
  queueDepth,
  reapAbandonedJobs,
  requeueJob,
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

async function drain(executor: 'server' | 'operator_gpu' | 'browser' = 'operator_gpu') {
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
    await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })

    await db
      .update(processingJobs)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(processingJobs.id, first))

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

    expect((await workerStatus(db as Db, muchLater)).online).toBe(false)
  })

  it('upserts on name rather than creating duplicates', async () => {
    await heartbeat(db as Db, 'local-5080', 'a')
    await heartbeat(db as Db, 'local-5080', 'b')

    const status = await workerStatus(db as Db)
    expect(status.modelName).toBe('b')
  })
})

/**
 * This used to read the single most recently heard-from row and report its
 * state as the fleet's, so one machine going down took the queue offline on
 * every screen that asks while another was still working through it.
 */
describe('a fleet of more than one worker', () => {
  // The suite shares one database, and the block above leaves a worker behind.
  // These count rows, so they start from an empty fleet.
  beforeEach(async () => {
    await db.delete(gpuWorkers)
  })

  it('is online while any one of them is', async () => {
    await heartbeat(db as Db, 'shed-3090', 'qwen2.5vl:7b')
    await heartbeat(db as Db, 'desk-5080', 'qwen2.5vl:7b')

    // The one heard from most recently is the one that stops, which is exactly
    // the row the old query would have picked.
    await markWorkerOffline(db as Db, 'desk-5080')

    const status = await workerStatus(db as Db)

    expect(status.online).toBe(true)
    expect(status.onlineCount).toBe(1)
    // And it names the one that is actually up, not the one that went down.
    expect(status.name).toBe('shed-3090')
  })

  it('is offline only once every one of them is', async () => {
    await heartbeat(db as Db, 'shed-3090', 'qwen2.5vl:7b')
    await heartbeat(db as Db, 'desk-5080', 'qwen2.5vl:7b')

    await markWorkerOffline(db as Db, 'shed-3090')
    await markWorkerOffline(db as Db, 'desk-5080')

    const status = await workerStatus(db as Db)

    expect(status.online).toBe(false)
    expect(status.onlineCount).toBe(0)
    // Still says when something was last heard from, so the screen can tell a
    // fleet that has gone quiet from one that was never set up.
    expect(status.lastHeartbeatAt).not.toBeNull()
  })

  it('counts them all when they are all up', async () => {
    await heartbeat(db as Db, 'shed-3090', 'qwen2.5vl:7b')
    await heartbeat(db as Db, 'desk-5080', 'qwen2.5vl:7b')

    expect((await workerStatus(db as Db)).onlineCount).toBe(2)
  })

  it('does not count one whose heartbeat has gone stale', async () => {
    await heartbeat(db as Db, 'shed-3090', 'qwen2.5vl:7b')
    await heartbeat(db as Db, 'desk-5080', 'qwen2.5vl:7b')

    const muchLater = new Date(Date.now() + 10 * 60_000)
    const status = await workerStatus(db as Db, muchLater)

    expect(status.online).toBe(false)
    expect(status.onlineCount).toBe(0)
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

/**
 * A student is capped at one extraction waiting on the GPU, and nothing
 * enforced it: the enqueue endpoint took as many worksheets as a script could
 * post, and one account could hold the whole queue against everybody else.
 */
describe('inFlightExtractCount', () => {
  it('counts nothing for a student with no work queued', async () => {
    await drain()
    expect(await inFlightExtractCount(db as Db, userId)).toBe(0)
  })

  it('counts a job from the moment it is enqueued, not from when it is claimed', async () => {
    await drain()
    await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })

    // Pending counts. A cap that only saw claimed work would let a student
    // queue a hundred and call none of them in flight.
    expect(await inFlightExtractCount(db as Db, userId)).toBe(MAX_IN_FLIGHT_EXTRACTS)

    await claimJob(db as Db, 'operator_gpu')
    expect(await inFlightExtractCount(db as Db, userId)).toBe(1)
  })

  it('stops counting once the job finishes', async () => {
    await drain()
    await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })

    const job = await claimJob(db as Db, 'operator_gpu')
    await completeJob(db as Db, job!.id)

    expect(await inFlightExtractCount(db as Db, userId)).toBe(0)
  })

  // The reason the cap is extract-only. Folding explanations in would mean a
  // student who uploaded a worksheet could not ask about a question from last
  // week until it finished.
  it('ignores explanation jobs, which are bounded separately', async () => {
    await drain()
    await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'explain',
      executor: 'operator_gpu',
      checkpoint: { questionId: 'q1' },
    })

    expect(await inFlightExtractCount(db as Db, userId)).toBe(0)
  })

  it('is per student, so one account cannot block another', async () => {
    await drain()
    const otherUser = await makeUser(db)
    const otherWorksheet = await makeWorksheet(db, otherUser)

    await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })

    expect(await inFlightExtractCount(db as Db, userId)).toBe(1)
    expect(await inFlightExtractCount(db as Db, otherUser)).toBe(0)

    await enqueueJob(db as Db, {
      worksheetId: otherWorksheet,
      userId: otherUser,
      stage: 'extract',
      executor: 'operator_gpu',
    })

    expect(await inFlightExtractCount(db as Db, otherUser)).toBe(1)
  })
})

/**
 * `attempt_count` increments on the claim, and `claimJob` refuses anything at
 * MAX_ATTEMPTS. So a worker that dies on its third claim, before it reports
 * anything, leaves a job past the ceiling and still marked claimed: unclaimable
 * forever, and nothing but a worker ever marks a job failed. The student's
 * worksheet sat at "Queued" for good and the trial credit was never refunded.
 */
describe('reapAbandonedJobs', () => {
  const longAgo = () => new Date(Date.now() - CLAIM_TTL_MS * 3)

  async function exhausted() {
    await drain()
    const jobId = await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })

    await db
      .update(processingJobs)
      .set({
        status: 'claimed',
        attemptCount: MAX_ATTEMPTS,
        claimedAt: longAgo(),
      })
      .where(eq(processingJobs.id, jobId))

    return jobId
  }

  it('fails a job no worker can ever claim again', async () => {
    const jobId = await exhausted()

    const reaped = await reapAbandonedJobs(db as Db)
    expect(reaped.map((row) => row.id)).toContain(jobId)

    const [row] = await db
      .select({ status: processingJobs.status, error: processingJobs.error })
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId))

    expect(row.status).toBe('failed')
    expect(row.error).toMatch(/stopped responding/)
  })

  it('reports the worksheet and stage, so the refund can be run', async () => {
    await exhausted()

    const [reaped] = await reapAbandonedJobs(db as Db)
    expect(reaped.worksheetId).toBe(worksheetId)
    expect(reaped.userId).toBe(userId)
    expect(reaped.stage).toBe('extract')
  })

  // A worker part-way through a long paper is holding a live claim, not an
  // abandoned one, and sweeping it would take the job out from under it.
  it('leaves a job whose claim has not expired', async () => {
    await drain()
    const jobId = await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })

    await db
      .update(processingJobs)
      .set({ status: 'running', attemptCount: MAX_ATTEMPTS, claimedAt: new Date() })
      .where(eq(processingJobs.id, jobId))

    expect(await reapAbandonedJobs(db as Db)).toHaveLength(0)
  })

  // Below the ceiling the job is still retryable: claimJob picks it up once the
  // claim goes stale, which is the normal retry and not an abandonment.
  it('leaves a stale job that still has attempts left', async () => {
    await drain()
    const jobId = await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })

    await db
      .update(processingJobs)
      .set({ status: 'claimed', attemptCount: 1, claimedAt: longAgo() })
      .where(eq(processingJobs.id, jobId))

    expect(await reapAbandonedJobs(db as Db)).toHaveLength(0)
    expect(await claimJob(db as Db, 'operator_gpu')).not.toBeNull()
  })
})

// Finding 118: the admin console's "stuck jobs" list, and the requeue/cancel
// controls next to it. Nothing in app/ offered either before this.
describe('listActionableJobs', () => {
  it('lists a claimed, running, failed and cancelled job, oldest concerns included', async () => {
    await drain()

    for (const status of ['claimed', 'running', 'failed', 'cancelled'] as const) {
      const jobId = await enqueueJob(db as Db, {
        worksheetId,
        userId,
        stage: 'extract',
        executor: 'operator_gpu',
      })
      await db.update(processingJobs).set({ status }).where(eq(processingJobs.id, jobId))
    }

    const listed = await listActionableJobs(db as Db)
    expect(listed.map((job) => job.status).sort()).toEqual(
      ['cancelled', 'claimed', 'failed', 'running'],
    )
  })

  it('leaves out pending and completed jobs, which need no operator action', async () => {
    await drain()

    const pendingId = await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })
    const completedId = await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })
    await db
      .update(processingJobs)
      .set({ status: 'completed' })
      .where(eq(processingJobs.id, completedId))

    const listed = await listActionableJobs(db as Db)
    expect(listed.map((job) => job.id)).not.toContain(pendingId)
    expect(listed.map((job) => job.id)).not.toContain(completedId)
  })

  it('carries the owner email, for telling accounts apart in the list', async () => {
    await drain()
    const jobId = await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })
    await db.update(processingJobs).set({ status: 'failed' }).where(eq(processingJobs.id, jobId))

    const [listed] = await listActionableJobs(db as Db)
    expect(listed.userEmail).toBeTruthy()
  })
})

describe('cancelJob', () => {
  it('cancels a claimed job and reports it for the refund path', async () => {
    await drain()
    const jobId = await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })
    await db
      .update(processingJobs)
      .set({ status: 'claimed' })
      .where(eq(processingJobs.id, jobId))

    const cancelled = await cancelJob(db as Db, jobId)

    expect(cancelled).toMatchObject({ id: jobId, worksheetId, userId, stage: 'extract' })

    const [row] = await db
      .select({ status: processingJobs.status, error: processingJobs.error })
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId))
    expect(row.status).toBe('cancelled')
    expect(row.error).toBe('Cancelled by an admin.')
  })

  it('does nothing to a job already finished one way or the other', async () => {
    await drain()
    const jobId = await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })
    await db
      .update(processingJobs)
      .set({ status: 'completed' })
      .where(eq(processingJobs.id, jobId))

    expect(await cancelJob(db as Db, jobId)).toBeNull()

    const [row] = await db
      .select({ status: processingJobs.status })
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId))
    expect(row.status).toBe('completed')
  })

  it('reports nothing for a job that does not exist', async () => {
    expect(await cancelJob(db as Db, 'nope')).toBeNull()
  })
})

describe('requeueJob', () => {
  it('gives a failed job a clean pending row with a fresh attempt budget', async () => {
    await drain()
    const jobId = await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })
    await db
      .update(processingJobs)
      .set({
        status: 'failed',
        attemptCount: MAX_ATTEMPTS,
        error: 'boom',
        claimedAt: new Date(),
      })
      .where(eq(processingJobs.id, jobId))

    expect(await requeueJob(db as Db, jobId)).toBe(true)

    const [row] = await db.select().from(processingJobs).where(eq(processingJobs.id, jobId))
    expect(row.status).toBe('pending')
    expect(row.attemptCount).toBe(0)
    expect(row.error).toBeNull()
    expect(row.claimedAt).toBeNull()
  })

  it('walks a failed worksheet back to queued, so the job has somewhere to land', async () => {
    await drain()
    const jobId = await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })
    await db
      .update(processingJobs)
      .set({ status: 'failed' })
      .where(eq(processingJobs.id, jobId))
    await db.update(worksheets).set({ status: 'failed' }).where(eq(worksheets.id, worksheetId))

    await requeueJob(db as Db, jobId)

    const [row] = await db
      .select({ status: worksheets.status })
      .from(worksheets)
      .where(eq(worksheets.id, worksheetId))
    expect(row.status).toBe('queued')
  })

  // A worksheet already reviewed and marked up is not this job's to reopen -
  // requeuing an old explain job, say, must not drag a finished paper back.
  it('leaves a worksheet alone when it is not the one sitting on failed', async () => {
    await drain()
    const jobId = await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })
    await db
      .update(processingJobs)
      .set({ status: 'failed' })
      .where(eq(processingJobs.id, jobId))
    await db.update(worksheets).set({ status: 'ready' }).where(eq(worksheets.id, worksheetId))

    await requeueJob(db as Db, jobId)

    const [row] = await db
      .select({ status: worksheets.status })
      .from(worksheets)
      .where(eq(worksheets.id, worksheetId))
    expect(row.status).toBe('ready')
  })

  it('refuses a job that is claimed or running, which a worker may still hold', async () => {
    await drain()
    const jobId = await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })
    await db
      .update(processingJobs)
      .set({ status: 'claimed' })
      .where(eq(processingJobs.id, jobId))

    expect(await requeueJob(db as Db, jobId)).toBe(false)

    const [row] = await db
      .select({ status: processingJobs.status })
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId))
    expect(row.status).toBe('claimed')
  })

  it('reports failure for a job that does not exist', async () => {
    expect(await requeueJob(db as Db, 'nope')).toBe(false)
  })
})

/**
 * The `userId` filter, which exists for exactly one caller.
 *
 * Tier C's worker is the student's own tab (app/api/browser-jobs/claim), so
 * unlike the two server-side executors it is neither trusted nor shared. The
 * claim response carries the worksheet's pages and their OCR text, so an
 * unfiltered claim from a browser is one student handed another's paper.
 */
describe('claimJob scoped to one user', () => {
  it('refuses a job belonging to somebody else', async () => {
    await drain('browser')

    const stranger = await makeUser(db)
    const theirWorksheet = await makeWorksheet(db, stranger)
    await enqueueJob(db as Db, {
      worksheetId: theirWorksheet,
      userId: stranger,
      stage: 'extract',
      executor: 'browser',
    })

    expect(await claimJob(db as Db, 'browser', null, new Date(), userId)).toBeNull()
  })

  it('hands over that user’s own job', async () => {
    await drain('browser')

    const jobId = await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'browser',
    })

    const claimed = await claimJob(db as Db, 'browser', null, new Date(), userId)

    expect(claimed?.id).toBe(jobId)
  })

  /**
   * The filter has to be opt-in, or adding it would have silently changed what
   * the operator's GPU and the Tier B drain claim: both pass no user and mean
   * "whatever is next", which is the whole point of a shared queue.
   */
  it('still takes anybody’s job when no user is named', async () => {
    await drain('browser')

    const stranger = await makeUser(db)
    const theirWorksheet = await makeWorksheet(db, stranger)
    const jobId = await enqueueJob(db as Db, {
      worksheetId: theirWorksheet,
      userId: stranger,
      stage: 'extract',
      executor: 'browser',
    })

    expect((await claimJob(db as Db, 'browser'))?.id).toBe(jobId)
  })
})
