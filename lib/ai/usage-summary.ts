import { and, desc, eq, gte, sql } from 'drizzle-orm'

import type { Db } from '@/lib/db/types'
import { usageEvents, users } from '@/lib/db/schema'

import { TRIAL_EXPLANATION_LIMIT, TRIAL_WORKSHEET_LIMIT } from './providers'

export interface UsageSummaryRow {
  kind: (typeof usageEvents.$inferSelect)['kind']
  tierUsed: (typeof usageEvents.$inferSelect)['tierUsed']
  events: number
  quantity: number
}

export const USAGE_SUMMARY_WINDOW_DAYS = 30

export async function usageSummary(
  db: Db,
  days = USAGE_SUMMARY_WINDOW_DAYS,
  now: Date = new Date(),
): Promise<UsageSummaryRow[]> {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)

  return db
    .select({
      kind: usageEvents.kind,
      tierUsed: usageEvents.tierUsed,
      events: sql<number>`count(*)::int`,
      quantity: sql<number>`coalesce(sum(${usageEvents.quantity}), 0)::int`,
    })
    .from(usageEvents)
    .where(and(gte(usageEvents.createdAt, since), eq(usageEvents.refunded, false)))
    .groupBy(usageEvents.kind, usageEvents.tierUsed)
    .orderBy(usageEvents.kind, usageEvents.tierUsed)
}

export interface TrialQuotaRow {
  userId: string
  email: string
  worksheetsUsed: number
  explanationsUsed: number
}

export async function trialQuotaLeaders(db: Db, limit = 20): Promise<TrialQuotaRow[]> {
  const usage = sql`${users.trialWorksheetsUsed} + ${users.trialExplanationsUsed}`

  return db
    .select({
      userId: users.id,
      email: users.email,
      worksheetsUsed: users.trialWorksheetsUsed,
      explanationsUsed: users.trialExplanationsUsed,
    })
    .from(users)
    .where(sql`${usage} > 0`)
    .orderBy(desc(usage))
    .limit(limit)
}

export { TRIAL_EXPLANATION_LIMIT, TRIAL_WORKSHEET_LIMIT }
