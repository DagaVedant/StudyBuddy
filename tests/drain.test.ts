import {strict as assert} from 'node:assert'
import test from 'node:test'
import {eq} from 'drizzle-orm'

import {type Db} from '@/lib/db'
import {checkpointJob, CLAIM_TTL_MS, claimJob, queueDepth, yieldJob} from '@/lib/queue'
import {processingJobs} from '@/lib/schema'

import {freshDb, makeUser, makeWorksheet, uid} from './support/db'

async function pendingExtract(db: Db) {
  const userId = await makeUser(db)
  const worksheetId = await makeWorksheet(db, userId)
  const id = uid('job')

  await db.insert(processingJobs).values({
    id,
    worksheetId,
    userId,
    stage: 'extract',
    executor: 'server',
  })

  return id
}

async function jobRow(db: Db, id: string) {
  const [row] = await db
    .select({
      status: processingJobs.status,
      attemptCount: processingJobs.attemptCount,
      checkpoint: processingJobs.checkpoint,
    })
    .from(processingJobs)
    .where(eq(processingJobs.id, id))
    .limit(1)

  return row
}

test('a yielded job goes back to pending with its checkpoint and without spending an attempt', async () => {
  const db = await freshDb()
  const id = await pendingExtract(db)

  const first = await claimJob(db, 'server')
  assert.ok(first)
  assert.equal(first.id, id)

  await checkpointJob(db, id, 0.4, {lastPageNumber: 10})
  await yieldJob(db, id)

  const yielded = await jobRow(db, id)
  assert.equal(yielded.status, 'pending')
  assert.deepEqual(yielded.checkpoint, {lastPageNumber: 10})
  assert.equal(yielded.attemptCount, 0)

  const second = await claimJob(db, 'server')
  assert.ok(second)
  assert.equal(second.id, id)
  assert.deepEqual(second.checkpoint, {lastPageNumber: 10})
  assert.equal(second.attemptCount, 1)
})

test('queue depth tells a live claim from a stale one', async () => {
  const db = await freshDb()
  await pendingExtract(db)

  const now = new Date()
  const claimed = await claimJob(db, 'server', null, now)
  assert.ok(claimed)

  const fresh = await queueDepth(db, 'server', now)
  assert.equal(fresh.pending, 0)
  assert.equal(fresh.running, 1)
  assert.equal(fresh.staleRunning, 0)

  const later = new Date(now.getTime() + CLAIM_TTL_MS + 1000)
  const stale = await queueDepth(db, 'server', later)
  assert.equal(stale.running, 1)
  assert.equal(stale.staleRunning, 1)
})
