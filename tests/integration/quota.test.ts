import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  TRIAL_EXPLANATION_LIMIT,
  TRIAL_WORKSHEET_LIMIT,
  consumeTrial,
  getTrialState,
  refundTrial,
} from '@/lib/ai/quota'
import type { Db } from '@/lib/dashboard/queries'
import { usageEvents, users } from '@/lib/db/schema'

import { createTestDb, type TestDb } from '../helpers/db'
import { makeUser } from '../helpers/factories'

let db: TestDb
let close: () => Promise<void>

beforeAll(async () => {
  const harness = await createTestDb()
  db = harness.db
  close = harness.close
})

afterAll(async () => {
  await close()
})

describe('consumeTrial', () => {
  it('starts a new account with the full allowance', async () => {
    const state = await getTrialState(db as Db, await makeUser(db))
    expect(state.worksheetsRemaining).toBe(TRIAL_WORKSHEET_LIMIT)
    expect(state.explanationsRemaining).toBe(TRIAL_EXPLANATION_LIMIT)
    expect(state.exhausted).toBe(false)
  })

  it('draws down the allowance', async () => {
    const userId = await makeUser(db)

    const result = await consumeTrial(db as Db, userId, 'worksheets', 1)
    expect(result.ok).toBe(true)
    expect(result.remaining).toBe(TRIAL_WORKSHEET_LIMIT - 1)
  })

  it('charges one worksheet no matter how many pages it has', async () => {
    const userId = await makeUser(db)

    // The whole point of the worksheet unit: a 112-page practice test costs
    // the same as a one-page quiz.
    await consumeTrial(db as Db, userId, 'worksheets', 1)

    expect((await getTrialState(db as Db, userId)).worksheetsRemaining).toBe(
      TRIAL_WORKSHEET_LIMIT - 1,
    )
  })

  it('refuses a request that would exceed the limit, all-or-nothing', async () => {
    const userId = await makeUser(db)

    expect((await consumeTrial(db as Db, userId, 'explanations', 18)).ok).toBe(true)

    // Five explanations with two left must not partially consume.
    const overflow = await consumeTrial(db as Db, userId, 'explanations', 5)
    expect(overflow.ok).toBe(false)
    expect(overflow.remaining).toBe(2)

    expect((await getTrialState(db as Db, userId)).explanationsUsed).toBe(18)
  })

  it('explains what to do next when it refuses', async () => {
    const userId = await makeUser(db)
    await consumeTrial(db as Db, userId, 'worksheets', TRIAL_WORKSHEET_LIMIT)

    const refused = await consumeTrial(db as Db, userId, 'worksheets', 1)
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.reason).toMatch(/API key|Ollama/i)
    }
  })

  it('tracks worksheets and explanations independently', async () => {
    const userId = await makeUser(db)
    await consumeTrial(db as Db, userId, 'worksheets', TRIAL_WORKSHEET_LIMIT)

    expect((await consumeTrial(db as Db, userId, 'explanations', 1)).ok).toBe(true)
  })

  it('cannot be raced past the limit', async () => {
    const userId = await makeUser(db)

    // The guard is in the UPDATE's WHERE clause, so concurrent callers can't
    // both pass a read-then-write check.
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        consumeTrial(db as Db, userId, 'worksheets', 1),
      ),
    )

    expect(results.filter((result) => result.ok)).toHaveLength(TRIAL_WORKSHEET_LIMIT)
    expect((await getTrialState(db as Db, userId)).worksheetsUsed).toBe(
      TRIAL_WORKSHEET_LIMIT,
    )
  })

  it('records a usage event so spend is auditable', async () => {
    const userId = await makeUser(db)
    await consumeTrial(db as Db, userId, 'worksheets', 1)

    const events = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.userId, userId))

    expect(events).toHaveLength(1)
    expect(events[0].quantity).toBe(1)
    expect(events[0].tierUsed).toBe('trial')
  })

  it('ignores a zero or negative amount', async () => {
    const userId = await makeUser(db)
    expect((await consumeTrial(db as Db, userId, 'worksheets', 0)).ok).toBe(true)
    expect((await getTrialState(db as Db, userId)).worksheetsUsed).toBe(0)
  })
})

describe('refundTrial', () => {
  it('gives the allowance back after a permanent failure', async () => {
    const userId = await makeUser(db)
    await consumeTrial(db as Db, userId, 'worksheets', 2)

    await refundTrial(db as Db, userId, 'worksheets', 2)

    expect((await getTrialState(db as Db, userId)).worksheetsRemaining).toBe(
      TRIAL_WORKSHEET_LIMIT,
    )
  })

  it('never refunds below zero', async () => {
    const userId = await makeUser(db)
    await refundTrial(db as Db, userId, 'worksheets', 99)

    const [row] = await db
      .select({ used: users.trialWorksheetsUsed })
      .from(users)
      .where(eq(users.id, userId))

    expect(row.used).toBe(0)
  })

  it('marks the usage event refunded', async () => {
    const userId = await makeUser(db)
    await consumeTrial(db as Db, userId, 'worksheets', 2)
    await refundTrial(db as Db, userId, 'worksheets', 2)

    const events = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.userId, userId))

    expect(events[0].refunded).toBe(true)
  })
})
