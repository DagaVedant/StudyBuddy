import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { worksheets } from '@/lib/db/schema'
import { transitionWorksheet } from '@/lib/upload/claim'

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

async function worksheetAt(status: (typeof worksheets.$inferSelect)['status']): Promise<string> {
  const userId = await makeUser(db)
  const [row] = await db
    .insert(worksheets)
    .values({ userId, title: 'Practice Set', sourceType: 'pdf_digital', pageCount: 1, status })
    .returning({ id: worksheets.id })
  return row.id
}

const statusOf = async (worksheetId: string) => {
  const [row] = await db
    .select({ status: worksheets.status })
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
  return row.status
}

/*
 * Finding 93. Every scattered `worksheets.status` write used to be a bare
 * `UPDATE ... WHERE id = ?`, which moves the row wherever the caller says
 * regardless of what it currently holds. This is the one place that check
 * now lives, so it gets its own test rather than only being exercised
 * indirectly through the callers that adopted it.
 */
describe('transitionWorksheet', () => {
  it('moves the row when the current status is in the allowed set', async () => {
    const worksheetId = await worksheetAt('queued')

    expect(
      await transitionWorksheet(client(), worksheetId, ['queued', 'processing'], {
        status: 'awaiting_review',
      }),
    ).toBe(true)

    expect(await statusOf(worksheetId)).toBe('awaiting_review')
  })

  it('refuses when the current status is not in the allowed set', async () => {
    const worksheetId = await worksheetAt('ready')

    expect(
      await transitionWorksheet(client(), worksheetId, ['queued', 'processing'], {
        status: 'failed',
      }),
    ).toBe(false)

    // Untouched, not overwritten with the same value.
    expect(await statusOf(worksheetId)).toBe('ready')
  })

  it('writes any extra fields passed alongside the status', async () => {
    const worksheetId = await worksheetAt('queued')

    await transitionWorksheet(client(), worksheetId, ['queued'], {
      status: 'awaiting_review',
      tierUsed: 'free',
    })

    const [row] = await db
      .select({ status: worksheets.status, tierUsed: worksheets.tierUsed })
      .from(worksheets)
      .where(eq(worksheets.id, worksheetId))

    expect(row.status).toBe('awaiting_review')
    expect(row.tierUsed).toBe('free')
  })

  // The check and the write are one statement so two callers racing to make
  // the same transition cannot both succeed.
  it('lets exactly one of two simultaneous callers through', async () => {
    const worksheetId = await worksheetAt('queued')

    const results = await Promise.all([
      transitionWorksheet(client(), worksheetId, ['queued'], { status: 'failed' }),
      transitionWorksheet(client(), worksheetId, ['queued'], { status: 'awaiting_review' }),
    ])

    expect(results.filter(Boolean)).toHaveLength(1)
  })
})
