import { and, desc, eq, gte, sql } from 'drizzle-orm'

import type { Db } from '@/lib/db/types'
import { usageEvents, users } from '@/lib/db/schema'

import { TRIAL_EXPLANATION_LIMIT, TRIAL_WORKSHEET_LIMIT } from './limits'

export interface UsageSummaryRow {
  kind: (typeof usageEvents.$inferSelect)['kind']
  tierUsed: (typeof usageEvents.$inferSelect)['tierUsed']
  events: number
  quantity: number
}

/** How far back {@link usageSummary} looks by default. */
export const USAGE_SUMMARY_WINDOW_DAYS = 30

/**
 * spec.md §2.1's "Aggregate usage_events" - a shape an admin can scan for
 * whether spend is where it should be (trial, not cloud - this app never
 * pays for a cloud call) without reading anyone's actual questions or
 * answers, which usage_events never carries in the first place.
 *
 * Refunded events are excluded rather than netted against their originals:
 * a refunded row already represents work that did not count against
 * anyone's trial, and folding it back in would make a spike in failures
 * look like a spike in usage.
 *
 * `now` defaults rather than being computed by the caller: the admin page
 * that calls this is a React server component, and computing `Date.now()`
 * inside a component's render is exactly the impurity
 * `react-hooks/purity` exists to catch. Tests inject it the same way
 * `reapAbandonedJobs` does.
 */
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

/**
 * spec.md §2.1's "per-user quota state" - who is closest to (or already at)
 * the trial ceiling, which is the operationally useful cut of `users`
 * rather than every account. Ordered by total consumption, not by whether
 * either counter has hit its limit, so an admin also sees who is about to.
 */
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
