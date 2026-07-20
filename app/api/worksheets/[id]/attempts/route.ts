import { and, eq, inArray } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { db } from '@/lib/db'
import {
  answerChoices,
  attempts,
  questions,
  reviewCards,
  reviewLogs,
} from '@/lib/db/schema'
import { scheduleFromOutcome, type StoredCard } from '@/lib/review/fsrs'
import { guardWorksheet } from '@/lib/upload/guard'

type Params = { params: Promise<{ id: string }> }

const markSchema = z.object({
  marks: z
    .array(
      z.object({
        questionId: z.string().min(1),
        outcome: z.enum(['correct', 'unsure', 'wrong']),
        selectedChoiceId: z.string().min(1).nullish(),
        freeTextAnswer: z.string().trim().max(2000).nullish(),
      }),
    )
    .min(1)
    .max(500),
})

export async function POST(request: Request, { params }: Params) {
  const { id: worksheetId } = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({ error: 'Not found' }, { status: guard.status })
  }

  const parsed = markSchema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const { marks } = parsed.data
  const questionIds = marks.map((mark) => mark.questionId)

  const owned = await db
    .select({ id: questions.id })
    .from(questions)
    .where(
      and(
        eq(questions.worksheetId, worksheetId),
        inArray(questions.id, questionIds),
      ),
    )

  const ownedIds = new Set(owned.map((row) => row.id))
  const accepted = marks.filter((mark) => ownedIds.has(mark.questionId))

  if (accepted.length === 0) {
    return NextResponse.json({ error: 'No matching questions' }, { status: 400 })
  }

  const validChoices = await db
    .select({ id: answerChoices.id, questionId: answerChoices.questionId })
    .from(answerChoices)
    .where(inArray(answerChoices.questionId, [...ownedIds]))

  const choiceOwner = new Map(validChoices.map((row) => [row.id, row.questionId]))
  const now = new Date()

  await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(reviewCards)
      .where(
        and(
          eq(reviewCards.userId, guard.userId),
          inArray(reviewCards.questionId, [...ownedIds]),
        ),
      )

    const cardByQuestion = new Map(existing.map((card) => [card.questionId, card]))

    for (const mark of accepted) {
      const selectedChoiceId =
        mark.selectedChoiceId &&
        choiceOwner.get(mark.selectedChoiceId) === mark.questionId
          ? mark.selectedChoiceId
          : null

      await tx.insert(attempts).values({
        userId: guard.userId,
        questionId: mark.questionId,
        outcome: mark.outcome,
        selectedChoiceId,
        freeTextAnswer: mark.freeTextAnswer ?? null,
        source: 'markup',
      })

      const current = cardByQuestion.get(mark.questionId)
      const stored: StoredCard | null = current
        ? {
            dueAt: current.dueAt,
            stability: current.stability,
            difficulty: current.difficulty,
            elapsedDays: current.elapsedDays,
            scheduledDays: current.scheduledDays,
            learningSteps: current.learningSteps,
            reps: current.reps,
            lapses: current.lapses,
            state: current.state,
            lastReview: current.lastReview,
          }
        : null

      const { card, log } = scheduleFromOutcome(stored, mark.outcome, now)

      const [saved] = await tx
        .insert(reviewCards)
        .values({
          userId: guard.userId,
          questionId: mark.questionId,
          ...card,
        })
        .onConflictDoUpdate({
          target: [reviewCards.userId, reviewCards.questionId],
          set: card,
        })
        .returning({ id: reviewCards.id })

      await tx.insert(reviewLogs).values({
        cardId: saved.id,
        rating: log.rating,
        state: log.state,
        elapsedDays: log.elapsedDays,
        scheduledDays: log.scheduledDays,
      })
    }
  })

  return NextResponse.json({
    ok: true,
    recorded: accepted.length,
    next: '/dashboard',
  })
}
