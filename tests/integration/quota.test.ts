import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  TRIAL_EXPLANATION_LIMIT,
  TRIAL_PAGE_LIMIT,
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
    expect(state.pagesRemaining).toBe(TRIAL_PAGE_LIMIT)
    expect(state.explanationsRemaining).toBe(TRIAL_EXPLANATION_LIMIT)
    expect(state.exhausted).toBe(false)
  })

  it('draws down the allowance', async () => {
    const userId = await makeUser(db)

    const result = await consumeTrial(db as Db, userId, 'pages', 4)
    expect(result.ok).toBe(true)
    expect(result.remaining).toBe(TRIAL_PAGE_LIMIT - 4)
  })

  it('refuses a request that would exceed the limit, all-or-nothing', async () => {
    const userId = await makeUser(db)

    expect((await consumeTrial(db as Db, userId, 'pages', 8)).ok).toBe(true)

    // A 5-page upload with 2 left must not partially consume.
    const overflow = await consumeTrial(db as Db, userId, 'pages', 5)
    expect(overflow.ok).toBe(false)
    expect(overflow.remaining).toBe(2)

    expect((await getTrialState(db as Db, userId)).pagesUsed).toBe(8)
  })

  it('explains what to do next when it refuses', async () => {
    const userId = await makeUser(db)
    await consumeTrial(db as Db, userId, 'pages', TRIAL_PAGE_LIMIT)

    const refused = await consumeTrial(db as Db, userId, 'pages', 1)
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.reason).toMatch(/API key|Ollama/i)
    }
  })

  it('tracks pages and explanations independently', async () => {
    const userId = await makeUser(db)
    await consumeTrial(db as Db, userId, 'pages', TRIAL_PAGE_LIMIT)

    expect((await consumeTrial(db as Db, userId, 'explanations', 1)).ok).toBe(true)
  })

  it('cannot be raced past the limit', async () => {
    const userId = await makeUser(db)

    // The guard is in the UPDATE's WHERE clause, so concurrent callers can't
    // both pass a read-then-write check.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => consumeTrial(db as Db, userId, 'pages', 1)),
    )

    expect(results.filter((result) => result.ok)).toHaveLength(TRIAL_PAGE_LIMIT)
    expect((await getTrialState(db as Db, userId)).pagesUsed).toBe(TRIAL_PAGE_LIMIT)
  })

  it('records a usage event so spend is auditable', async () => {
    const userId = await makeUser(db)
    await consumeTrial(db as Db, userId, 'pages', 3)

    const events = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.userId, userId))

    expect(events).toHaveLength(1)
    expect(events[0].quantity).toBe(3)
    expect(events[0].tierUsed).toBe('trial')
  })

  it('ignores a zero or negative amount', async () => {
    const userId = await makeUser(db)
    expect((await consumeTrial(db as Db, userId, 'pages', 0)).ok).toBe(true)
    expect((await getTrialState(db as Db, userId)).pagesUsed).toBe(0)
  })
})

describe('refundTrial', () => {
  it('gives the allowance back after a permanent failure', async () => {
    const userId = await makeUser(db)
    await consumeTrial(db as Db, userId, 'pages', 5)

    await refundTrial(db as Db, userId, 'pages', 5)

    expect((await getTrialState(db as Db, userId)).pagesRemaining).toBe(
      TRIAL_PAGE_LIMIT,
    )
  })

  it('never refunds below zero', async () => {
    const userId = await makeUser(db)
    await refundTrial(db as Db, userId, 'pages', 99)

    const [row] = await db
      .select({ used: users.trialPagesUsed })
      .from(users)
      .where(eq(users.id, userId))

    expect(row.used).toBe(0)
  })

  it('marks the usage event refunded', async () => {
    const userId = await makeUser(db)
    await consumeTrial(db as Db, userId, 'pages', 2)
    await refundTrial(db as Db, userId, 'pages', 2)

    const events = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.userId, userId))

    expect(events[0].refunded).toBe(true)
  })
})
