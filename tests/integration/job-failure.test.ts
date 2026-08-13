import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { users, worksheets } from '@/lib/db/schema'
import { applyPermanentFailure } from '@/lib/worker/fail'

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

async function seed(options: {
  tierUsed: 'trial' | 'cloud'
  status?: 'ready' | 'queued'
  worksheetsUsed?: number
  explanationsUsed?: number
}) {
  const userId = await makeUser(db)

  await db
    .update(users)
    .set({
      trialWorksheetsUsed: options.worksheetsUsed ?? 3,
      trialExplanationsUsed: options.explanationsUsed ?? 4,
    })
    .where(eq(users.id, userId))

  const [row] = await db
    .insert(worksheets)
    .values({
      userId,
      title: 'Practice Set',
      sourceType: 'pdf_digital',
      pageCount: 1,
      status: options.status ?? 'ready',
      tierUsed: options.tierUsed,
    })
    .returning({ id: worksheets.id })

  return { userId, worksheetId: row.id }
}

const counters = async (userId: string) => {
  const [row] = await db
    .select({
      worksheets: users.trialWorksheetsUsed,
      explanations: users.trialExplanationsUsed,
    })
    .from(users)
    .where(eq(users.id, userId))
  return row
}

const statusOf = async (worksheetId: string) => {
  const [row] = await db
    .select({ status: worksheets.status })
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
  return row.status
}

describe('applyPermanentFailure', () => {
  // The one that did three wrong things at once. An explain job carries the
  // worksheet its question came from, and the handler could not tell the two
  // kinds of job apart.
  it('leaves the worksheet alone when an explanation fails', async () => {
    const { userId, worksheetId } = await seed({ tierUsed: 'trial' })

    await applyPermanentFailure(client(), {
      stage: 'explain',
      userId,
      worksheetId,
    })

    // Still finished. It was extracted, verified and marked up.
    expect(await statusOf(worksheetId)).toBe('ready')

    const after = await counters(userId)
    expect(after.explanations).toBe(3) // the credit it actually charged
    expect(after.worksheets).toBe(3) // untouched
  })

  it('fails the worksheet and refunds it when extraction fails on the trial', async () => {
    const { userId, worksheetId } = await seed({ tierUsed: 'trial', status: 'queued' })

    await applyPermanentFailure(client(), {
      stage: 'extract',
      userId,
      worksheetId,
    })

    expect(await statusOf(worksheetId)).toBe('failed')

    const after = await counters(userId)
    expect(after.worksheets).toBe(2)
    expect(after.explanations).toBe(4) // untouched
  })

  // A student's own key already paid whoever owns it.
  it('refunds nothing when the worksheet did not use the trial', async () => {
    const { userId, worksheetId } = await seed({ tierUsed: 'cloud', status: 'queued' })

    await applyPermanentFailure(client(), {
      stage: 'extract',
      userId,
      worksheetId,
    })

    expect(await statusOf(worksheetId)).toBe('failed')

    const after = await counters(userId)
    expect(after.worksheets).toBe(3)
    expect(after.explanations).toBe(4)
  })

  /*
   * The same mistake as the explain one, made again by a stage added later.
   *
   * Solving runs after the worksheet is finished and readable, takes the better
   * part of an hour on a long paper, and never checkpoints, so it is the stage
   * most likely to be reaped at the attempt ceiling. Falling through to the
   * extraction branch, it refunded a worksheet credit correctly spent on an
   * extraction that had succeeded, and failed a paper the student may already
   * have marked up.
   */
  it('leaves the worksheet alone when solving fails', async () => {
    const { userId, worksheetId } = await seed({ tierUsed: 'trial' })

    await applyPermanentFailure(client(), {
      stage: 'answer_key',
      userId,
      worksheetId,
    })

    // The paper is exactly what it was. Answers are an addition to it.
    expect(await statusOf(worksheetId)).toBe('ready')

    const after = await counters(userId)
    expect(after.worksheets).toBe(3) // the extraction it paid for succeeded
    expect(after.explanations).toBe(4)
  })

  it('does not push a counter below zero', async () => {
    const { userId, worksheetId } = await seed({
      tierUsed: 'trial',
      explanationsUsed: 0,
    })

    await applyPermanentFailure(client(), {
      stage: 'explain',
      userId,
      worksheetId,
    })

    expect((await counters(userId)).explanations).toBe(0)
  })
})
