import {strict as assert} from 'node:assert'
import test from 'node:test'

import {type Db} from '@/lib/db'
import {CLAIM_TTL_MS, claimJob} from '@/lib/queue'
import {processingJobs} from '@/lib/schema'

import {freshDb, makeUser, makeWorksheet, uid} from './support/db'

async function pendingJob(db: Db) {
  const userId = await makeUser(db)
  const worksheetId = await makeWorksheet(db, userId)
  const id = uid('job')
  await db.insert(processingJobs).values({
    id,
    worksheetId,
    userId,
    stage: 'extract',
    executor: 'operator_gpu',
  })
  return id
}

test('a claimed job is not handed to a second worker', async () => {
  const db = await freshDb()
  const id = await pendingJob(db)
  const now = new Date()

  assert.equal((await claimJob(db, 'operator_gpu', null, now))?.id, id)
  assert.equal(await claimJob(db, 'operator_gpu', null, now), null)
})

test('a claim abandoned mid-flight is reclaimed once it goes stale', async () => {
  const db = await freshDb()
  const id = await pendingJob(db)
  const now = new Date()

  const first = await claimJob(db, 'operator_gpu', null, now)
  assert.equal(first?.attemptCount, 1)

  // The worker dies here: the row stays 'claimed' with nobody working it.
  const stillHeld = new Date(now.getTime() + CLAIM_TTL_MS - 1_000)
  assert.equal(await claimJob(db, 'operator_gpu', null, stillHeld), null)

  const expired = new Date(now.getTime() + CLAIM_TTL_MS + 1_000)
  const second = await claimJob(db, 'operator_gpu', null, expired)
  assert.equal(second?.id, id)
  assert.equal(second?.attemptCount, 2)
})

test('a job is abandoned for good once it has burned its attempts', async () => {
  const db = await freshDb()
  await pendingJob(db)
  const start = Date.now()

  const rounds = 12
  let claims = 0
  for (let i = 0; i < rounds; i += 1) {
    const at = new Date(start + i * (CLAIM_TTL_MS + 1_000))
    if (await claimJob(db, 'operator_gpu', null, at)) claims += 1
  }

  assert.ok(claims < rounds, 'a stale job was reclaimed forever')
})
