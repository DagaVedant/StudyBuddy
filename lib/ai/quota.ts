import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'

import type { Db } from '@/lib/db/types'
import { processingJobs, usageEvents, users, worksheets } from '@/lib/db/schema'

import { TRIAL_EXPLANATION_LIMIT, TRIAL_WORKSHEET_LIMIT } from './providers'

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

function eventKindFor(kind: TrialKind) {
  return kind === 'worksheets' ? 'extract_page' : 'explain'
}

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
    kind: eventKindFor(kind),
    tierUsed: 'trial',
    quantity: amount,
  })

  return { ok: true, remaining: Math.max(0, limit - used) }
}

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

  const pending = await db
    .select({ id: usageEvents.id, quantity: usageEvents.quantity })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.userId, userId),
        eq(usageEvents.kind, eventKindFor(kind)),
        eq(usageEvents.tierUsed, 'trial'),
        eq(usageEvents.refunded, false),
      ),
    )
    .orderBy(desc(usageEvents.createdAt))

  const refunding: string[] = []
  let covered = 0

  for (const event of pending) {
    if (covered >= amount) break
    refunding.push(event.id)
    covered += event.quantity
  }

  if (refunding.length > 0) {
    await db
      .update(usageEvents)
      .set({ refunded: true })
      .where(inArray(usageEvents.id, refunding))
  }
}

const DAY_MS = 24 * 3600_000

export async function trialExtractionsToday(
  db: Db,
  now: Date = new Date(),
): Promise<number> {
  const since = new Date(now.getTime() - DAY_MS)

  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(processingJobs)
    .innerJoin(worksheets, eq(worksheets.id, processingJobs.worksheetId))
    .where(
      and(
        eq(processingJobs.stage, 'extract'),
        eq(processingJobs.executor, 'operator_gpu'),
        eq(worksheets.tierUsed, 'trial'),
        gte(processingJobs.createdAt, since),
      ),
    )

  return Number(row?.value ?? 0)
}
