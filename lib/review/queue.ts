import { and, asc, desc, eq, inArray, lte } from 'drizzle-orm'

import type { Db } from '@/lib/db/types'
import {
  answerChoices,
  attempts,
  explanations,
  questions,
  reviewCards,
  topics,
  questionTopics,
} from '@/lib/db/schema'
import { formatInterval, previewIntervals, type ReviewRating } from '@/lib/review/fsrs'

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
  correctAnswer: string | null
  answerSource: string
  choices: ReviewChoice[]
  topicName: string | null
  lastOutcome: string | null
  lastChoiceId: string | null
  lastFreeText: string | null
  explanation: { body: string; reportedWrong: boolean } | null
  dueAt: string
  /**
   * What each rating would cost you, as a label under the button ("3 d").
   * Computed here rather than in the browser so ts-fsrs and the scheduler
   * parameters stay server-side.
   */
  intervals: Record<ReviewRating, string>
}

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
      stability: reviewCards.stability,
      difficulty: reviewCards.difficulty,
      elapsedDays: reviewCards.elapsedDays,
      scheduledDays: reviewCards.scheduledDays,
      learningSteps: reviewCards.learningSteps,
      reps: reviewCards.reps,
      lapses: reviewCards.lapses,
      state: reviewCards.state,
      lastReview: reviewCards.lastReview,
      promptText: questions.promptText,
      questionType: questions.questionType,
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

  // Indexed once instead of scanned four times per card. Each of the four
  // lists below was searched linearly for every card in the queue, so the
  // work grew with the product of the two rather than their sum.
  const choicesFor = new Map<string, typeof choices>()
  for (const choice of choices) {
    const list = choicesFor.get(choice.questionId)
    if (list) list.push(choice)
    else choicesFor.set(choice.questionId, [choice])
  }

  // Both of these arrive newest first, so the first entry for a question is
  // the one to keep, which is what `.find()` was picking out.
  const lastAttemptFor = new Map<string, (typeof lastAttempts)[number]>()
  for (const attempt of lastAttempts) {
    if (!lastAttemptFor.has(attempt.questionId)) {
      lastAttemptFor.set(attempt.questionId, attempt)
    }
  }

  const explanationFor = new Map<string, (typeof explanationRows)[number]>()
  for (const row of explanationRows) {
    if (!explanationFor.has(row.questionId)) explanationFor.set(row.questionId, row)
  }

  const topicNameFor = new Map<string, string>()
  for (const row of topicRows) {
    if (!topicNameFor.has(row.questionId)) topicNameFor.set(row.questionId, row.name)
  }

  return cards.map((card) => {
    const last = lastAttemptFor.get(card.questionId)
    const explanation = explanationFor.get(card.questionId)

    const preview = previewIntervals(
      {
        dueAt: card.dueAt,
        stability: card.stability,
        difficulty: card.difficulty,
        elapsedDays: card.elapsedDays,
        scheduledDays: card.scheduledDays,
        learningSteps: card.learningSteps,
        reps: card.reps,
        lapses: card.lapses,
        state: card.state,
        lastReview: card.lastReview,
      },
      now,
    )

    return {
      cardId: card.cardId,
      questionId: card.questionId,
      promptText: card.promptText,
      questionType: card.questionType,
      correctAnswer: card.correctAnswer,
      answerSource: card.answerSource,
      choices: (choicesFor.get(card.questionId) ?? []).map((choice) => ({
        id: choice.id,
        label: choice.label,
        text: choice.text,
        isCorrect: choice.isCorrect,
      })),
      topicName: topicNameFor.get(card.questionId) ?? null,
      lastOutcome: last?.outcome ?? null,
      lastChoiceId: last?.selectedChoiceId ?? null,
      lastFreeText: last?.freeTextAnswer ?? null,
      explanation: explanation
        ? { body: explanation.bodyMd, reportedWrong: explanation.reportedWrong }
        : null,
      dueAt: card.dueAt.toISOString(),
      intervals: {
        again: formatInterval(preview.again, now),
        hard: formatInterval(preview.hard, now),
        good: formatInterval(preview.good, now),
        easy: formatInterval(preview.easy, now),
      },
    }
  })
}
