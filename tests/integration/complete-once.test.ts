import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { worksheets } from '@/lib/db/schema'
import { claimWorksheetForCompletion } from '@/lib/upload/claim'

import { asDb, createTestDb, type TestDb } from '../helpers/db'
import { makeUser } from '../helpers/factories'

let db: TestDb
let close: () => Promise<void>

beforeAll(async () => {
  const created = await createTestDb()
  db = created.db
  close = created.close
})

afterAll(async () => {
  await close()
})

const client = () => asDb(db)

async function uploadedWorksheet(
  userId: string,
  status: 'uploading' | 'processing' = 'processing',
): Promise<string> {
  const [row] = await db
    .insert(worksheets)
    .values({
      userId,
      title: 'Practice Set',
      sourceType: 'pdf_digital',
      pageCount: 1,
      status,
    })
    .returning({ id: worksheets.id })

  return row.id
}

describe('claimWorksheetForCompletion', () => {
  it('lets the first caller through and refuses the second', async () => {
    const userId = await makeUser(db)
    const worksheetId = await uploadedWorksheet(userId)

    expect(await claimWorksheetForCompletion(client(), worksheetId, 'queued', 'trial')).toBe(
      true,
    )
    expect(await claimWorksheetForCompletion(client(), worksheetId, 'queued', 'trial')).toBe(
      false,
    )
  })

  it('records the status and tier the winner asked for', async () => {
    const userId = await makeUser(db)
    const worksheetId = await uploadedWorksheet(userId)

    await claimWorksheetForCompletion(client(), worksheetId, 'awaiting_review', 'free')

    const [row] = await db
      .select({ status: worksheets.status, tierUsed: worksheets.tierUsed })
      .from(worksheets)
      .where(eq(worksheets.id, worksheetId))

    expect(row.status).toBe('awaiting_review')
    expect(row.tierUsed).toBe('free')
  })

  it('does not let a loser overwrite what the winner recorded', async () => {
    const userId = await makeUser(db)
    const worksheetId = await uploadedWorksheet(userId)

    await claimWorksheetForCompletion(client(), worksheetId, 'queued', 'trial')
    await claimWorksheetForCompletion(client(), worksheetId, 'awaiting_review', 'free')

    const [row] = await db
      .select({ status: worksheets.status, tierUsed: worksheets.tierUsed })
      .from(worksheets)
      .where(eq(worksheets.id, worksheetId))

    expect(row.status).toBe('queued')
    expect(row.tierUsed).toBe('trial')
  })

  it('lets exactly one of two simultaneous callers through', async () => {
    const userId = await makeUser(db)
    const worksheetId = await uploadedWorksheet(userId)

    const results = await Promise.all([
      claimWorksheetForCompletion(client(), worksheetId, 'queued', 'trial'),
      claimWorksheetForCompletion(client(), worksheetId, 'queued', 'trial'),
    ])

    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('also claims one still marked uploading', async () => {
    const userId = await makeUser(db)
    const worksheetId = await uploadedWorksheet(userId, 'uploading')

    expect(await claimWorksheetForCompletion(client(), worksheetId, 'queued', 'trial')).toBe(
      true,
    )
  })

  it('refuses a worksheet that is already finished', async () => {
    const userId = await makeUser(db)
    const [row] = await db
      .insert(worksheets)
      .values({
        userId,
        title: 'Practice Set',
        sourceType: 'pdf_digital',
        pageCount: 1,
        status: 'ready',
      })
      .returning({ id: worksheets.id })

    expect(await claimWorksheetForCompletion(client(), row.id, 'queued', 'trial')).toBe(false)
  })
})
