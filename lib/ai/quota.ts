import { and, eq, sql } from 'drizzle-orm'

import type { Db } from '@/lib/dashboard/queries'
import { usageEvents, users } from '@/lib/db/schema'

/**
 * Tier 0 trial accounting (spec §3.1).
 *
 * A **lifetime** allowance, not monthly — otherwise the free tier is just a
 * rate-limited free tier and the operator's GPU carries the product forever.
 * Enforced server-side at enqueue; a client cannot mint free GPU jobs.
 */

export const TRIAL_PAGE_LIMIT = 10
export const TRIAL_EXPLANATION_LIMIT = 20

export type TrialKind = 'pages' | 'explanations'

export interface TrialState {
  pagesUsed: number
  pagesRemaining: number
  explanationsUsed: number
  explanationsRemaining: number
  exhausted: boolean
}

export async function getTrialState(db: Db, userId: string): Promise<TrialState> {
  const [row] = await db
    .select({
      pagesUsed: users.trialPagesUsed,
      explanationsUsed: users.trialExplanationsUsed,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  const pagesUsed = row?.pagesUsed ?? 0
  const explanationsUsed = row?.explanationsUsed ?? 0

  const pagesRemaining = Math.max(0, TRIAL_PAGE_LIMIT - pagesUsed)
  const explanationsRemaining = Math.max(
    0,
    TRIAL_EXPLANATION_LIMIT - explanationsUsed,
  )

  return {
    pagesUsed,
    pagesRemaining,
    explanationsUsed,
    explanationsRemaining,
    exhausted: pagesRemaining === 0 && explanationsRemaining === 0,
  }
}

export type ConsumeResult =
  | { ok: true; remaining: number }
  | { ok: false; remaining: number; reason: string }

/**
 * Consumes allowance up front, at enqueue rather than on success — otherwise a
 * client could spin the GPU by repeatedly starting jobs it never finishes.
 * Permanent failures refund (see `refundTrial`).
 *
 * The guard lives in the UPDATE's WHERE clause so two concurrent requests
 * can't both pass a read-then-write check.
 */
export async function consumeTrial(
  db: Db,
  userId: string,
  kind: TrialKind,
  amount = 1,
): Promise<ConsumeResult> {
  if (amount <= 0) return { ok: true, remaining: 0 }

  const isPages = kind === 'pages'
  const column = isPages ? users.trialPagesUsed : users.trialExplanationsUsed
  const limit = isPages ? TRIAL_PAGE_LIMIT : TRIAL_EXPLANATION_LIMIT

  const updated = await db
    .update(users)
    .set({ [isPages ? 'trialPagesUsed' : 'trialExplanationsUsed']: sql`${column} + ${amount}` })
    .where(and(eq(users.id, userId), sql`${column} + ${amount} <= ${limit}`))
    .returning({
      pagesUsed: users.trialPagesUsed,
      explanationsUsed: users.trialExplanationsUsed,
    })

  if (updated.length === 0) {
    const state = await getTrialState(db, userId)
    const remaining = isPages ? state.pagesRemaining : state.explanationsRemaining

    return {
      ok: false,
      remaining,
      reason: isPages
        ? `Your free trial covers ${TRIAL_PAGE_LIMIT} pages and you have ${remaining} left. Add an API key or connect Ollama in settings to keep going.`
        : `Your free trial covers ${TRIAL_EXPLANATION_LIMIT} explanations and you have ${remaining} left. Add an API key or connect Ollama in settings to keep going.`,
    }
  }

  const used = isPages ? updated[0].pagesUsed : updated[0].explanationsUsed

  await db.insert(usageEvents).values({
    userId,
    kind: isPages ? 'extract_page' : 'explain',
    tierUsed: 'trial',
    quantity: amount,
  })

  return { ok: true, remaining: Math.max(0, limit - used) }
}

/**
 * Gives allowance back after a permanent failure (spec §12 assumption 9).
 * Without this a student could burn their whole trial on jobs that crashed,
 * and deliberate failures would be a way to farm free GPU time.
 */
export async function refundTrial(
  db: Db,
  userId: string,
  kind: TrialKind,
  amount = 1,
): Promise<void> {
  if (amount <= 0) return

  const isPages = kind === 'pages'
  const column = isPages ? users.trialPagesUsed : users.trialExplanationsUsed

  await db
    .update(users)
    .set({
      [isPages ? 'trialPagesUsed' : 'trialExplanationsUsed']: sql`greatest(${column} - ${amount}, 0)`,
    })
    .where(eq(users.id, userId))

  await db
    .update(usageEvents)
    .set({ refunded: true })
    .where(and(eq(usageEvents.userId, userId), eq(usageEvents.refunded, false)))
}
