import { and, asc, desc, eq, inArray, lte } from 'drizzle-orm'

import type { Db } from '@/lib/dashboard/queries'
import {
  answerChoices,
  attempts,
  explanations,
  questions,
  reviewCards,
  topics,
  questionTopics,
} from '@/lib/db/schema'

export interface ReviewChoice {
  id: string
  label: string
  text: string
  isCorrect: boolean
}

export interface ReviewItem {
  cardId: string
  questionId: string
  promptText: string
  questionType: string
  figureImageKey: string | null
  correctAnswer: string | null
  /** 'ai_derived' drives the "not from an answer key" badge (spec §4 stage 4). */
  answerSource: string
  choices: ReviewChoice[]
  topicName: string | null
  /** What the student put last time, so the card can show their actual mistake. */
  lastOutcome: string | null
  lastChoiceId: string | null
  lastFreeText: string | null
  explanation: { body: string; reportedWrong: boolean } | null
  dueAt: string
}

/**
 * The due queue (spec §5.4). Ordered by how overdue a card is, so the most
 * neglected material comes back first.
 */
export async function getDueCards(
  db: Db,
  userId: string,
  limit = 20,
  now: Date = new Date(),
): Promise<ReviewItem[]> {
  const cards = await db
    .select({
      cardId: reviewCards.id,
      questionId: reviewCards.questionId,
      dueAt: reviewCards.dueAt,
      promptText: questions.promptText,
      questionType: questions.questionType,
      figureImageKey: questions.figureImageKey,
      correctAnswer: questions.correctAnswer,
      answerSource: questions.answerSource,
    })
    .from(reviewCards)
    .innerJoin(questions, eq(questions.id, reviewCards.questionId))
    .where(and(eq(reviewCards.userId, userId), lte(reviewCards.dueAt, now)))
    .orderBy(asc(reviewCards.dueAt))
    .limit(limit)

  if (cards.length === 0) return []

  const questionIds = cards.map((card) => card.questionId)

  const [choices, lastAttempts, topicRows, explanationRows] = await Promise.all([
    db
      .select()
      .from(answerChoices)
      .where(inArray(answerChoices.questionId, questionIds)),
    db
      .select()
      .from(attempts)
      .where(
        and(eq(attempts.userId, userId), inArray(attempts.questionId, questionIds)),
      )
      .orderBy(desc(attempts.createdAt)),
    db
      .select({
        questionId: questionTopics.questionId,
        name: topics.name,
      })
      .from(questionTopics)
      .innerJoin(topics, eq(topics.id, questionTopics.topicId))
      .where(
        and(
          inArray(questionTopics.questionId, questionIds),
          eq(questionTopics.isPrimary, true),
        ),
      ),
    db
      .select()
      .from(explanations)
      .where(inArray(explanations.questionId, questionIds))
      .orderBy(desc(explanations.generatedAt)),
  ])

  return cards.map((card) => {
    // Already sorted newest-first, so the first hit is the latest.
    const last = lastAttempts.find((attempt) => attempt.questionId === card.questionId)
    const explanation = explanationRows.find(
      (row) => row.questionId === card.questionId,
    )

    return {
      cardId: card.cardId,
      questionId: card.questionId,
      promptText: card.promptText,
      questionType: card.questionType,
      figureImageKey: card.figureImageKey,
      correctAnswer: card.correctAnswer,
      answerSource: card.answerSource,
      choices: choices
        .filter((choice) => choice.questionId === card.questionId)
        .map((choice) => ({
          id: choice.id,
          label: choice.label,
          text: choice.text,
          isCorrect: choice.isCorrect,
        })),
      topicName:
        topicRows.find((row) => row.questionId === card.questionId)?.name ?? null,
      lastOutcome: last?.outcome ?? null,
      lastChoiceId: last?.selectedChoiceId ?? null,
      lastFreeText: last?.freeTextAnswer ?? null,
      explanation: explanation
        ? { body: explanation.bodyMd, reportedWrong: explanation.reportedWrong }
        : null,
      dueAt: card.dueAt.toISOString(),
    }
  })
}
