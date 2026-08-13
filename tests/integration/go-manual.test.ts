import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { processingJobs, users, worksheets } from '@/lib/db/schema'
import { claimWorksheetForManualFallback } from '@/lib/upload/claim'
import { enqueueJob } from '@/lib/queue'
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

async function queuedWorksheet(userId: string): Promise<string> {
  const [row] = await db
    .insert(worksheets)
    .values({
      userId,
      title: 'Practice Set',
      sourceType: 'pdf_digital',
      pageCount: 1,
      status: 'processing',
      tierUsed: 'trial',
    })
    .returning({ id: worksheets.id })
  return row.id
}

/**
 * The atomic claim behind `POST /api/worksheets/[id]/go-manual`.
 *
 * Same shape as `claimWorksheetForCompletion`'s own test, and for the same
 * reason: this is what stops a double click from cancelling the same job or
 * refunding the same trial credit twice.
 */
describe('claimWorksheetForManualFallback', () => {
  it('lets the first caller through and refuses the second', async () => {
    const userId = await makeUser(db)
    const worksheetId = await queuedWorksheet(userId)

    expect(await claimWorksheetForManualFallback(client(), worksheetId)).toBe(true)
    expect(await claimWorksheetForManualFallback(client(), worksheetId)).toBe(false)

    const [row] = await db
      .select({ status: worksheets.status })
      .from(worksheets)
      .where(eq(worksheets.id, worksheetId))
    expect(row.status).toBe('failed')
  })

  it('refuses a worksheet that already finished', async () => {
    const userId = await makeUser(db)
    const worksheetId = await queuedWorksheet(userId)
    await db.update(worksheets).set({ status: 'ready' }).where(eq(worksheets.id, worksheetId))

    expect(await claimWorksheetForManualFallback(client(), worksheetId)).toBe(false)

    const [row] = await db
      .select({ status: worksheets.status })
      .from(worksheets)
      .where(eq(worksheets.id, worksheetId))
    expect(row.status).toBe('ready')
  })
})

/**
 * The full sequence the route runs, exercised end to end against real rows:
 * cancel the open job, refund the trial, leave the worksheet in the state
 * the status page's existing manual-entry branch already renders.
 *
 * This is the part that matters most. A job left `pending` after the student
 * has started entering questions by hand is a job the worker can still claim
 * the moment it comes back online, extracting straight into a worksheet
 * someone is already editing.
 */
describe('the go-manual sequence', () => {
  it('cancels the open job and refunds the trial credit it spent', async () => {
    const userId = await makeUser(db)
    await db.update(users).set({ trialWorksheetsUsed: 1 }).where(eq(users.id, userId))

    const worksheetId = await queuedWorksheet(userId)
    const jobId = await enqueueJob(client(), {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })

    const won = await claimWorksheetForManualFallback(client(), worksheetId)
    expect(won).toBe(true)

    await db
      .update(processingJobs)
      .set({ status: 'cancelled', error: 'went manual' })
      .where(eq(processingJobs.id, jobId))

    await applyPermanentFailure(client(), { stage: 'extract', userId, worksheetId })

    const [job] = await db
      .select({ status: processingJobs.status })
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId))
    expect(job.status).toBe('cancelled')

    const [account] = await db
      .select({ used: users.trialWorksheetsUsed })
      .from(users)
      .where(eq(users.id, userId))
    expect(account.used).toBe(0)
  })

  // A cancelled job must never be reachable by the worker's own claim query,
  // or the whole point of cancelling it is lost.
  it('a cancelled job is never claimable again', async () => {
    const userId = await makeUser(db)
    const worksheetId = await queuedWorksheet(userId)
    const jobId = await enqueueJob(client(), {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })

    await db
      .update(processingJobs)
      .set({ status: 'cancelled' })
      .where(eq(processingJobs.id, jobId))

    const { claimJob } = await import('@/lib/queue')
    expect(await claimJob(client(), 'operator_gpu')).toBeNull()
  })
})
