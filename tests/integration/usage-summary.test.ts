import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { trialQuotaLeaders, usageSummary } from '@/lib/ai/usage-summary'
import { usageEvents, users } from '@/lib/db/schema'

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

async function event(over: {
  userId: string
  kind?: 'extract_page' | 'answer_derive' | 'classify' | 'explain'
  tierUsed?: 'trial' | 'free' | 'cloud' | 'ollama'
  quantity?: number
  refunded?: boolean
  createdAt?: Date
}) {
  await db.insert(usageEvents).values({
    userId: over.userId,
    kind: over.kind ?? 'extract_page',
    tierUsed: over.tierUsed ?? 'trial',
    quantity: over.quantity ?? 1,
    refunded: over.refunded ?? false,
    createdAt: over.createdAt ?? new Date(),
  })
}

/*
 * Finding 118: spec.md §2.1 lists usage visibility as an admin capability
 * and nothing in app/ queried usage_events at all.
 */
describe('usageSummary', () => {
  it('groups by kind and tier, counting events and summed quantity', async () => {
    const userId = await makeUser(db)
    await event({ userId, kind: 'extract_page', tierUsed: 'trial', quantity: 3 })
    await event({ userId, kind: 'extract_page', tierUsed: 'trial', quantity: 2 })
    await event({ userId, kind: 'explain', tierUsed: 'trial', quantity: 1 })

    const rows = await usageSummary(client(), 36500)

    const extract = rows.find((r) => r.kind === 'extract_page' && r.tierUsed === 'trial')
    expect(extract).toMatchObject({ events: 2, quantity: 5 })

    const explain = rows.find((r) => r.kind === 'explain' && r.tierUsed === 'trial')
    expect(explain).toMatchObject({ events: 1, quantity: 1 })
  })

  it('excludes refunded events entirely, not just nets them out', async () => {
    const userId = await makeUser(db)
    await event({ userId, kind: 'classify', quantity: 4, refunded: true })

    const rows = await usageSummary(client(), 36500)

    expect(rows.some((r) => r.kind === 'classify')).toBe(false)
  })

  it('excludes events before the cutoff', async () => {
    const userId = await makeUser(db)
    const now = new Date('2026-06-01T00:00:00Z')
    const sixtyDaysAgo = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 60)
    await event({ userId, kind: 'answer_derive', createdAt: sixtyDaysAgo })

    const rows = await usageSummary(client(), 30, now)

    expect(rows.some((r) => r.kind === 'answer_derive')).toBe(false)
  })

  it('defaults to a 30 day window', async () => {
    const userId = await makeUser(db)
    const now = new Date('2026-06-01T00:00:00Z')
    const twentyNineDaysAgo = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 29)
    await event({ userId, kind: 'answer_derive', createdAt: twentyNineDaysAgo })

    const rows = await usageSummary(client(), undefined, now)

    expect(rows.some((r) => r.kind === 'answer_derive')).toBe(true)
  })
})

describe('trialQuotaLeaders', () => {
  it('orders by total trial consumption, worksheets plus explanations', async () => {
    const low = await makeUser(db)
    const high = await makeUser(db)

    await db
      .update(users)
      .set({ trialWorksheetsUsed: 1, trialExplanationsUsed: 0 })
      .where(eq(users.id, low))
    await db
      .update(users)
      .set({ trialWorksheetsUsed: 3, trialExplanationsUsed: 20 })
      .where(eq(users.id, high))

    const leaders = await trialQuotaLeaders(client(), 50)
    const ids = leaders.map((row) => row.userId)

    expect(ids.indexOf(high)).toBeLessThan(ids.indexOf(low))
  })

  it('leaves out an account with no trial usage at all', async () => {
    const untouched = await makeUser(db)

    const leaders = await trialQuotaLeaders(client(), 50)

    expect(leaders.map((row) => row.userId)).not.toContain(untouched)
  })

  it('respects the limit', async () => {
    for (let i = 0; i < 5; i += 1) {
      const id = await makeUser(db)
      await db.update(users).set({ trialWorksheetsUsed: 1 }).where(eq(users.id, id))
    }

    expect(await trialQuotaLeaders(client(), 2)).toHaveLength(2)
  })
})
