import {strict as assert} from 'node:assert'
import test from 'node:test'
import {eq} from 'drizzle-orm'

import {type Db} from '@/lib/db'
import {checkpointJob, CLAIM_TTL_MS, claimJob, queueDepth, yieldJob} from '@/lib/queue'
import {processingJobs, questions} from '@/lib/schema'
import {CLAIM_WINDOW_MS, drainServerQueue, runSolvingJob} from '@/lib/worker/jobs'
import {type AIProvider} from '@/lib/ai/types'

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

async function pendingAnswerKeys(db: Db, count: number) {
  const userId = await makeUser(db)
  const worksheetId = await makeWorksheet(db, userId)
  const ids: string[] = []

  for (let i = 0; i < count; i++) {
    const id = uid('job')
    await db.insert(processingJobs).values({
      id,
      worksheetId,
      userId,
      stage: 'answer_key',
      executor: 'server',
    })
    ids.push(id)
  }

  return ids
}

async function statuses(db: Db, ids: string[]) {
  const out: string[] = []
  for (const id of ids) {
    const row = await jobRow(db, id)
    out.push(row.status)
  }
  return out
}

test('a hop claims a second job only while there is time to finish it', async () => {
  const db = await freshDb()
  process.env.ENABLE_MOCK_AI = 'true'

  const early = await pendingAnswerKeys(db, 2)
  await drainServerQueue(db, 5, Date.now())
  assert.deepEqual(await statuses(db, early), ['completed', 'completed'])

  const late = await pendingAnswerKeys(db, 2)
  await drainServerQueue(db, 5, Date.now() - CLAIM_WINDOW_MS - 1000)
  assert.deepEqual(await statuses(db, late), ['completed', 'pending'])
})

function silentProvider() {
  return {
    name: 'mock',
    answeringModel: 'silent',
    async answerBatch() {
      return []
    },
  } as unknown as AIProvider
}

async function solvingJobs(db: Db, worksheetId: string) {
  return db
    .select({id: processingJobs.id, status: processingJobs.status, checkpoint: processingJobs.checkpoint})
    .from(processingJobs)
    .where(eq(processingJobs.worksheetId, worksheetId))
    .orderBy(processingJobs.createdAt)
}

test('a batch that comes back empty is retried once and only once', async () => {
  const db = await freshDb()
  const userId = await makeUser(db)
  const worksheetId = await makeWorksheet(db, userId)

  await db.insert(questions).values({
    id: uid('q'),
    userId,
    worksheetId,
    ordinal: 1,
    promptText: 'What is 2 + 2?',
    questionType: 'multiple_choice',
  })

  const firstId = uid('job')
  await db.insert(processingJobs).values({
    id: firstId,
    worksheetId,
    userId,
    stage: 'answer_key',
    executor: 'server',
  })

  await runSolvingJob(db, silentProvider(), {id: firstId, worksheetId, userId, checkpoint: null})

  const afterFirst = await solvingJobs(db, worksheetId)
  assert.equal(afterFirst.length, 2)
  assert.equal(afterFirst[0].status, 'completed')
  assert.equal(afterFirst[1].status, 'pending')
  assert.deepEqual(afterFirst[1].checkpoint, {retry: 1})

  const retry = afterFirst[1]
  await runSolvingJob(db, silentProvider(), {id: retry.id, worksheetId, userId, checkpoint: retry.checkpoint})

  const afterRetry = await solvingJobs(db, worksheetId)
  assert.equal(afterRetry.length, 2)
  assert.equal(afterRetry[1].status, 'completed')
})
