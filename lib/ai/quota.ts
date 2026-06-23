import { and, eq, sql } from 'drizzle-orm'

import type { Db } from '@/lib/dashboard/queries'
import { usageEvents, users } from '@/lib/db/schema'

import { TRIAL_EXPLANATION_LIMIT, TRIAL_WORKSHEET_LIMIT } from './limits'

/**
 * Tier 0 trial accounting (spec §3.1).
 *
 * A **lifetime** allowance, not monthly — otherwise the free tier is just a
 * rate-limited free tier and the operator's GPU carries the product forever.
 * Enforced server-side at enqueue; a client cannot mint free GPU jobs.
 *
 * The numbers live in `./limits` so client components can quote them without
 * pulling the schema into the browser bundle.
 */

export { TRIAL_EXPLANATION_LIMIT, TRIAL_WORKSHEET_LIMIT }

export type TrialKind = 'worksheets' | 'explanations'

export interface TrialState {
  worksheetsUsed: number
  worksheetsRemaining: number
  explanationsUsed: number
  explanationsRemaining: number
  exhausted: boolean
}

export async function getTrialState(db: Db, userId: string): Promise<TrialState> {
  const [row] = await db
    .select({
      worksheetsUsed: users.trialWorksheetsUsed,
      explanationsUsed: users.trialExplanationsUsed,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  const worksheetsUsed = row?.worksheetsUsed ?? 0
  const explanationsUsed = row?.explanationsUsed ?? 0

  const worksheetsRemaining = Math.max(0, TRIAL_WORKSHEET_LIMIT - worksheetsUsed)
  const explanationsRemaining = Math.max(
    0,
    TRIAL_EXPLANATION_LIMIT - explanationsUsed,
  )

  return {
    worksheetsUsed,
    worksheetsRemaining,
    explanationsUsed,
    explanationsRemaining,
    exhausted: worksheetsRemaining === 0 && explanationsRemaining === 0,
  }
}

export type ConsumeResult =
  | { ok: true; remaining: number }
  | { ok: false; remaining: number; reason: string }

function columnFor(kind: TrialKind) {
  return kind === 'worksheets' ? users.trialWorksheetsUsed : users.trialExplanationsUsed
}

function fieldFor(kind: TrialKind) {
  return kind === 'worksheets' ? 'trialWorksheetsUsed' : 'trialExplanationsUsed'
}

function limitFor(kind: TrialKind) {
  return kind === 'worksheets' ? TRIAL_WORKSHEET_LIMIT : TRIAL_EXPLANATION_LIMIT
}

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

  const column = columnFor(kind)
  const limit = limitFor(kind)

  const updated = await db
    .update(users)
    .set({ [fieldFor(kind)]: sql`${column} + ${amount}` })
    .where(and(eq(users.id, userId), sql`${column} + ${amount} <= ${limit}`))
    .returning({
      worksheetsUsed: users.trialWorksheetsUsed,
      explanationsUsed: users.trialExplanationsUsed,
    })

  if (updated.length === 0) {
    const state = await getTrialState(db, userId)
    const remaining =
      kind === 'worksheets' ? state.worksheetsRemaining : state.explanationsRemaining

    return {
      ok: false,
      remaining,
      reason:
        kind === 'worksheets'
          ? `Your free trial covers ${TRIAL_WORKSHEET_LIMIT} worksheets and you have ${remaining} left. Add an API key or connect Ollama in settings to keep going.`
          : `Your free trial covers ${TRIAL_EXPLANATION_LIMIT} explanations and you have ${remaining} left. Add an API key or connect Ollama in settings to keep going.`,
    }
  }

  const used =
    kind === 'worksheets' ? updated[0].worksheetsUsed : updated[0].explanationsUsed

  await db.insert(usageEvents).values({
    userId,
    kind: kind === 'worksheets' ? 'extract_page' : 'explain',
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

  const column = columnFor(kind)

  await db
    .update(users)
    .set({ [fieldFor(kind)]: sql`greatest(${column} - ${amount}, 0)` })
    .where(eq(users.id, userId))

  await db
    .update(usageEvents)
    .set({ refunded: true })
    .where(and(eq(usageEvents.userId, userId), eq(usageEvents.refunded, false)))
}
