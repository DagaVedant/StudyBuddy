import {strict as assert} from 'node:assert'
import test from 'node:test'

import {eq} from 'drizzle-orm'

import {CACHED_SAMPLES, findMatchingSample} from '@/lib/samples'
import {worksheetPages, worksheets} from '@/lib/schema'

import {freshDb, makeUser, makeWorksheet, uid} from './support/db'

const SAMPLE = CACHED_SAMPLES.find((entry) => entry.pages.length === 1)!

async function uploadSample(
  db: Awaited<ReturnType<typeof freshDb>>,
  userId: string,
): Promise<string> {
  const worksheetId = await makeWorksheet(db, userId)

  await db.insert(worksheetPages).values({
    id: uid('page'),
    worksheetId,
    pageNumber: 1,
    imageKey: `${worksheetId}/1.webp`,
    width: 1000,
    height: 1400,
    ocrText: `${SAMPLE.title} — practice questions`,
  })

  return worksheetId
}

test('the cached sample is free the first time', async () => {
  const db = await freshDb()
  const userId = await makeUser(db)
  const worksheetId = await uploadSample(db, userId)

  const match = await findMatchingSample(db, worksheetId, userId)

  assert.equal(match?.sample.slug, SAMPLE.slug)
})

test('the same sample twice does not keep skipping the trial', async () => {
  const db = await freshDb()
  const userId = await makeUser(db)

  const first = await uploadSample(db, userId)
  assert.ok(await findMatchingSample(db, first, userId), 'the first run was not free')

  // what the completed run records, and what a second attempt has to notice
  await db
    .update(worksheets)
    .set({sampleSlug: SAMPLE.slug})
    .where(eq(worksheets.id, first))

  const second = await uploadSample(db, userId)
  const match = await findMatchingSample(db, second, userId)

  assert.equal(
    match,
    null,
    'the sample matched again, so the trial can be skipped indefinitely',
  )
})

test('one account using a sample does not spend it for everyone', async () => {
  const db = await freshDb()
  const mine = await makeUser(db)
  const theirs = await makeUser(db)

  const used = await uploadSample(db, mine)
  await db
    .update(worksheets)
    .set({sampleSlug: SAMPLE.slug})
    .where(eq(worksheets.id, used))

  const fresh = await uploadSample(db, theirs)

  assert.ok(
    await findMatchingSample(db, fresh, theirs),
    'a different account was charged for someone else using the sample',
  )
})
