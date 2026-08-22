import {strict as assert} from 'node:assert'
import test from 'node:test'

import {claimWorksheetForCompletion} from '@/lib/queue'
import {worksheets} from '@/lib/schema'
import {eq} from 'drizzle-orm'

import {freshDb, makeUser, makeWorksheet} from './support/db'

test('completing a worksheet twice only counts once', async () => {
  const db = await freshDb()
  const userId = await makeUser(db)
  const worksheetId = await makeWorksheet(db, userId)

  // Two requests for the same upload: a retry, a double-tap, a replayed job.
  const first = await claimWorksheetForCompletion(db, worksheetId, 'queued', 'trial')
  const second = await claimWorksheetForCompletion(db, worksheetId, 'queued', 'trial')

  assert.equal(first, true)
  assert.equal(second, false, 'the second run also claimed the worksheet')
})

test('a worksheet already past completion is not dragged back', async () => {
  const db = await freshDb()
  const userId = await makeUser(db)
  const worksheetId = await makeWorksheet(db, userId)

  await claimWorksheetForCompletion(db, worksheetId, 'awaiting_review', 'cloud')
  const again = await claimWorksheetForCompletion(db, worksheetId, 'queued', 'trial')

  assert.equal(again, false)

  const [row] = await db
    .select({status: worksheets.status, tierUsed: worksheets.tierUsed})
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))

  assert.equal(row.status, 'awaiting_review')
  assert.equal(row.tierUsed, 'cloud')
})
