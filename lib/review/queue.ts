import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'

import type { Db } from '@/lib/db/types'
import { CHOICE_ORDER } from '@/lib/questions/choice-order'
import {
  answerChoices,
  attempts,
  explanations,
  questions,
  reviewCards,
  topics,
  questionTopics,
  worksheetPages,
} from '@/lib/db/schema'
import { evidenceFor, type QuestionEvidence } from '@/lib/questions/evidence'
import { formatInterval, previewIntervals, type ReviewRating } from '@/lib/review/fsrs'

/**
 * The cards the review tab draws from: still wanted, not retired.
 *
 * "Ever wrong or guessed" is the same test the Blooket export applies, and the
 * two are meant to describe the same set of questions minus whatever the
 * student has said they have. A guess is a question answered by luck, so it
 * belongs here for the same reason a miss does.
 *
 * `exists` rather than a join: a question carries one attempt from markup and
 * another from every review sitting, so joining would return the card once per
 * time it was answered.
 */
export function inReviewQueue(userId: string, now: Date = new Date()) {
  return and(
    isNull(reviewCards.retiredAt),
    // Never practised here, or practised and due again.
    //
    // The first half is what makes the tab a complete list of what you got
    // wrong: a question is available the moment it is marked, rather than
    // waiting out whatever interval ts-fsrs picked from the mark. The second is
    // what lets a sitting finish, since a card you have just answered goes back
    // on the schedule instead of coming round again.
    //
    // "Practised here" is an attempt written by the review screen. `lastReview`
    // cannot answer this and neither can `review_logs`: marking a worksheet
    // writes both, so every card would look practised the moment it was
    // created, which is the behaviour this replaced.
    or(
      sql`not exists (
        select 1 from ${attempts}
        where ${attempts.questionId} = ${reviewCards.questionId}
          and ${attempts.userId} = ${userId}
          and ${attempts.source} = 'review'
      )`,
      lte(reviewCards.dueAt, now),
    ),
    sql`exists (
      select 1 from ${attempts}
      where ${attempts.questionId} = ${reviewCards.questionId}
        and ${attempts.userId} = ${userId}
        and ${attempts.outcome} in ('wrong', 'unsure')
    )`,
  )
}

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
  /**
   * The page, cropped to this question, or null when it cannot be placed.
   *
   * A question about a diagram, a net or a graph cannot be answered from its
   * text, and nothing in the pipeline ever cropped a figure to its own file, so
   * this screen showed those as text with no picture. The box and the page
   * image are both already stored; this is the same crop window the verify
   * screen draws, which is why it needs no new pass and no new storage.
   */
  evidence: QuestionEvidence | null
  dueAt: string
  /**
   * What each rating would cost you, as a label under the button ("3 d").
   * Computed here rather than in the browser so ts-fsrs and the scheduler
   * parameters stay server-side.
   */
  intervals: Record<ReviewRating, string>
}

/**
 * How many cards {@link getDueCards} would return without its limit.
 *
 * The review screen loads a sitting of twenty and used to print that twenty as
 * the number due, so a student with sixty waiting read "60" on the dashboard,
 * clicked through, and read "20 questions are due". Neither number was wrong
 * and the screen never said they were counting different things.
 *
 * Deliberately built from the same predicate as the query it describes rather
 * than from the dashboard's, which is a narrower one: the tile counts cards
 * past their due date, and this queue also carries cards never practised here
 * whatever the scheduler says. Two counts of "due" that disagree is the bug
 * being fixed, so this one is defined as "what the next screen will draw from"
 * and nothing else.
 */
export async function countReviewQueue(
  db: Db,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(reviewCards)
    .where(and(eq(reviewCards.userId, userId), inReviewQueue(userId, now)))

  return Number(row?.value ?? 0)
}

/**
 * Everything still worth practising, most overdue first.
 *
 * A question you have never practised is here from the moment it is marked
 * wrong, rather than waiting out whatever interval ts-fsrs picked: hiding it
 * for three days left the review tab empty on an evening a student sat down
 * specifically to work through their mistakes. Once it has been practised it
 * goes on the schedule like anything else, which is what lets a sitting finish
 * instead of dealing the same card round after round.
 *
 * What takes a question out is the student saying so. `retiredAt` is set by the
 * "Got it" button and is the only thing that removes a card from this list.
 * The card is not deleted and the attempts behind it are untouched, so the
 * question still counts as one they got wrong on the worksheet card, on the
 * topic page and in the Blooket export.
 *
 * A card whose question was only ever answered correctly is not in here at all:
 * markup writes a card for every question on the paper, including the ones the
 * student got right, and those were never the point of this screen.
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
      bbox: questions.bbox,
      // Left, not inner: a question added by hand has no page, and losing it
      // from the queue to fetch a picture it never had would be a poor trade.
      pageImageKey: worksheetPages.imageKey,
      pageWidth: worksheetPages.width,
      pageHeight: worksheetPages.height,
    })
    .from(reviewCards)
    .innerJoin(questions, eq(questions.id, reviewCards.questionId))
    .leftJoin(worksheetPages, eq(worksheetPages.id, questions.pageId))
    .where(and(eq(reviewCards.userId, userId), inReviewQueue(userId, now)))
    .orderBy(asc(reviewCards.dueAt))
    .limit(limit)

  if (cards.length === 0) return []

  const questionIds = cards.map((card) => card.questionId)

  const [choices, lastAttempts, topicRows, explanationRows] = await Promise.all([
    db
      .select()
      .from(answerChoices)
      .where(inArray(answerChoices.questionId, questionIds))
      .orderBy(...CHOICE_ORDER),
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
      evidence: card.pageImageKey
        ? evidenceFor(card.bbox, {
            imageKey: card.pageImageKey,
            width: card.pageWidth,
            height: card.pageHeight,
          })
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
