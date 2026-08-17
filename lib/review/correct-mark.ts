import { and, eq } from 'drizzle-orm'

import { answerChoices, attempts, questions, reviewCards } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'

import { scheduleFromOutcome, type Outcome } from './fsrs'

export interface Correction {
  questionId: string
  outcome: Outcome
  selectedChoiceId?: string | null
  freeTextAnswer?: string | null
}

export type CorrectionResult =
  | { ok: true; outcome: Outcome; rescheduled: boolean }
  | { ok: false; reason: 'no-question' | 'not-marked' }

export async function correctMarkupAttempt(
  db: Db,
  userId: string,
  worksheetId: string,
  input: Correction,
): Promise<CorrectionResult> {
  const [question] = await db
    .select({ id: questions.id })
    .from(questions)
    .where(
      and(eq(questions.worksheetId, worksheetId), eq(questions.id, input.questionId)),
    )
    .limit(1)

  if (!question) return { ok: false, reason: 'no-question' }

  const [existing] = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(
      and(
        eq(attempts.userId, userId),
        eq(attempts.questionId, input.questionId),
        eq(attempts.source, 'markup'),
      ),
    )
    .limit(1)

  if (!existing) return { ok: false, reason: 'not-marked' }

  const [choice] = input.selectedChoiceId
    ? await db
        .select({ id: answerChoices.id })
        .from(answerChoices)
        .where(
          and(
            eq(answerChoices.id, input.selectedChoiceId),
            eq(answerChoices.questionId, input.questionId),
          ),
        )
        .limit(1)
    : []

  const now = new Date()
  let rescheduled = false

  await db.transaction(async (tx) => {
    await tx
      .update(attempts)
      .set({
        outcome: input.outcome,
        selectedChoiceId: choice?.id ?? null,
        freeTextAnswer: input.freeTextAnswer ?? null,
      })
      .where(eq(attempts.id, existing.id))

    const [practised] = await tx
      .select({ id: attempts.id })
      .from(attempts)
      .where(
        and(
          eq(attempts.userId, userId),
          eq(attempts.questionId, input.questionId),
          eq(attempts.source, 'review'),
        ),
      )
      .limit(1)

    if (practised) return

    const { card } = scheduleFromOutcome(null, input.outcome, now)

    await tx
      .insert(reviewCards)
      .values({ userId, questionId: input.questionId, ...card })
      .onConflictDoUpdate({
        target: [reviewCards.userId, reviewCards.questionId],
        set: {
          ...card,
          retiredAt: null,
        },
      })

    rescheduled = true
  })

  return { ok: true, outcome: input.outcome, rescheduled }
}
