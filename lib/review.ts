import {and, asc, desc, eq, inArray, isNull, lte, or, sql} from 'drizzle-orm'
import {createEmptyCard, fsrs, Rating, type Card, type Grade, type State} from 'ts-fsrs'

import {CHOICE_ORDER} from '@/lib/questions/queries'
import {answerChoices, attempts, explanations, questionTopics, questions, reviewCards, topics, worksheetPages} from '@/lib/schema'
import {type Db} from '@/lib/db'
import {type QuestionEvidence, evidenceFor} from '@/lib/questions/shape'

function inTopic(topicId?: string | null) {
  if (!topicId) return undefined

  return sql`exists (
    select 1 from ${questionTopics}
    where ${questionTopics.questionId} = ${reviewCards.questionId}
      and ${questionTopics.topicId} = ${topicId}
  )`
}

export function inReviewQueue(userId: string, now: Date = new Date()) {
  return and(
    isNull(reviewCards.retiredAt),
    or(
      sql`not exists (
        select 1 from ${attempts}
        where ${attempts.questionId} = ${reviewCards.questionId}
          and ${attempts.userId} = ${userId}
          and ${attempts.source} = 'review'
      )`,
      lte(reviewCards.dueAt, now),
    ),
    or(
      sql`exists (
        select 1 from ${attempts}
        where ${attempts.questionId} = ${reviewCards.questionId}
          and ${attempts.userId} = ${userId}
          and ${attempts.outcome} in ('wrong', 'unsure')
      )`,
      sql`exists (
        select 1 from ${questions}
        where ${questions.id} = ${reviewCards.questionId}
          and ${questions.origin} = 'generated'
      )`,
    ),
  )
}

export type ReviewChoice = {
  id: string
  label: string
  text: string
  isCorrect: boolean
}

export type ReviewIntervals = {
  again: string
  hard: string
  good: string
  easy: string
}

export type ReviewItem = {
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
  explanation: {body: string; reportedWrong: boolean} | null
  evidence: QuestionEvidence | null
  dueAt: string
  intervals: ReviewIntervals
}

export async function countReviewQueue(
  db: Db,
  userId: string,
  now: Date = new Date(),
  topicId?: string | null,
) {
  const [row] = await db
    .select({value: sql<number>`count(*)::int`})
    .from(reviewCards)
    .where(
      and(eq(reviewCards.userId, userId), inReviewQueue(userId, now), inTopic(topicId)),
    )

  return Number(row.value)
}

export async function getDueCards(
  db: Db,
  userId: string,
  limit = 20,
  now: Date = new Date(),
  topicId?: string | null,
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
      pageImageKey: worksheetPages.imageKey,
      pageWidth: worksheetPages.width,
      pageHeight: worksheetPages.height,
    })
    .from(reviewCards)
    .innerJoin(questions, eq(questions.id, reviewCards.questionId))
    .leftJoin(worksheetPages, eq(worksheetPages.id, questions.pageId))
    .where(
      and(eq(reviewCards.userId, userId), inReviewQueue(userId, now), inTopic(topicId)),
    )
    .orderBy(asc(reviewCards.dueAt))
    .limit(limit)

  if (cards.length === 0) return []

  const questionIds: string[] = []
  for (const card of cards) questionIds.push(card.questionId)

  const [choices, lastAttempts, topicRows, explanationRows] = await Promise.all([
    db
      .select()
      .from(answerChoices)
      .where(inArray(answerChoices.questionId, questionIds))
      .orderBy(...CHOICE_ORDER),
    db
      .select()
      .from(attempts)
      .where(and(eq(attempts.userId, userId), inArray(attempts.questionId, questionIds)))
      .orderBy(desc(attempts.createdAt)),
    db
      .select({questionId: questionTopics.questionId, name: topics.name})
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

  const choicesFor = new Map<string, typeof choices>()
  for (const choice of choices) {
    const list = choicesFor.get(choice.questionId)
    if (list) list.push(choice)
    else choicesFor.set(choice.questionId, [choice])
  }

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

  const items: ReviewItem[] = []

  for (const card of cards) {
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

    const cardChoices: ReviewChoice[] = []
    const stored = choicesFor.get(card.questionId)

    if (stored) {
      for (const choice of stored) {
        cardChoices.push({
          id: choice.id,
          label: choice.label,
          text: choice.text,
          isCorrect: choice.isCorrect,
        })
      }
    }

    let topicName: string | null = null
    const named = topicNameFor.get(card.questionId)
    if (named) topicName = named

    let lastOutcome = null
    let lastChoiceId = null
    let lastFreeText = null

    if (last) {
      lastOutcome = last.outcome
      lastChoiceId = last.selectedChoiceId
      lastFreeText = last.freeTextAnswer
    }

    let explanationOut = null
    if (explanation) {
      explanationOut = {body: explanation.bodyMd, reportedWrong: explanation.reportedWrong}
    }

    let evidence = null
    if (card.pageImageKey) {
      evidence = evidenceFor(card.bbox, {
        imageKey: card.pageImageKey,
        width: card.pageWidth,
        height: card.pageHeight,
      })
    }

    items.push({
      cardId: card.cardId,
      questionId: card.questionId,
      promptText: card.promptText,
      questionType: card.questionType,
      correctAnswer: card.correctAnswer,
      answerSource: card.answerSource,
      choices: cardChoices,
      topicName: topicName,
      lastOutcome: lastOutcome,
      lastChoiceId: lastChoiceId,
      lastFreeText: lastFreeText,
      explanation: explanationOut,
      evidence: evidence,
      dueAt: card.dueAt.toISOString(),
      intervals: {
        again: formatInterval(preview.again, now),
        hard: formatInterval(preview.hard, now),
        good: formatInterval(preview.good, now),
        easy: formatInterval(preview.easy, now),
      },
    })
  }

  return items
}

const scheduler = fsrs()

export type Outcome = 'correct' | 'unsure' | 'wrong'
export type CardStateName = 'new' | 'learning' | 'review' | 'relearning'
export type ReviewRating = 'again' | 'hard' | 'good' | 'easy'

const STATE_NAMES: CardStateName[] = ['new', 'learning', 'review', 'relearning']

export type StoredCard = {
  dueAt: Date
  stability: number
  difficulty: number
  elapsedDays: number
  scheduledDays: number
  learningSteps: number
  reps: number
  lapses: number
  state: CardStateName
  lastReview: Date | null
}

export type ScheduleResult = {
  card: StoredCard
  log: {
    rating: number
    state: CardStateName
    elapsedDays: number
    scheduledDays: number
  }
}

function toStateName(state: State) {
  return STATE_NAMES[state]
}

function toStateValue(name: CardStateName) {
  return STATE_NAMES.indexOf(name) as State
}

function toFsrsCard(stored: StoredCard | null, now: Date): Card {
  if (!stored) return createEmptyCard(now)

  let lastReview = undefined
  if (stored.lastReview) lastReview = stored.lastReview

  return {
    due: stored.dueAt,
    stability: stored.stability,
    difficulty: stored.difficulty,
    elapsed_days: stored.elapsedDays,
    scheduled_days: stored.scheduledDays,
    learning_steps: stored.learningSteps,
    reps: stored.reps,
    lapses: stored.lapses,
    state: toStateValue(stored.state),
    last_review: lastReview,
  }
}

function fromFsrsCard(card: Card): StoredCard {
  let lastReview = null
  if (card.last_review) lastReview = card.last_review

  return {
    dueAt: card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: toStateName(card.state),
    lastReview: lastReview,
  }
}

function schedule(stored: StoredCard | null, grade: Grade, now: Date): ScheduleResult {
  const next = scheduler.next(toFsrsCard(stored, now), now, grade)

  return {
    card: fromFsrsCard(next.card),
    log: {
      rating: next.log.rating,
      state: toStateName(next.log.state),
      elapsedDays: next.log.elapsed_days,
      scheduledDays: next.log.scheduled_days,
    },
  }
}

function gradeForOutcome(outcome: Outcome): Grade {
  if (outcome === 'wrong') return Rating.Again
  if (outcome === 'unsure') return Rating.Hard

  return Rating.Good
}

function gradeForRating(rating: ReviewRating): Grade {
  if (rating === 'again') return Rating.Again
  if (rating === 'hard') return Rating.Hard
  if (rating === 'easy') return Rating.Easy

  return Rating.Good
}

export function scheduleFromOutcome(
  stored: StoredCard | null,
  outcome: Outcome,
  now: Date = new Date(),
) {
  return schedule(stored, gradeForOutcome(outcome), now)
}

export function scheduleFromReview(
  stored: StoredCard,
  rating: ReviewRating,
  now: Date = new Date(),
) {
  return schedule(stored, gradeForRating(rating), now)
}

function previewIntervals(stored: StoredCard, now: Date = new Date()) {
  const base = toFsrsCard(stored, now)

  return {
    again: scheduler.next(base, now, Rating.Again).card.due,
    hard: scheduler.next(base, now, Rating.Hard).card.due,
    good: scheduler.next(base, now, Rating.Good).card.due,
    easy: scheduler.next(base, now, Rating.Easy).card.due,
  }
}

function formatInterval(due: Date, now: Date = new Date()) {
  const minutes = Math.round((due.getTime() - now.getTime()) / 60000)

  if (minutes < 1) return '<1 min'
  if (minutes < 60) return minutes + ' min'

  const hours = Math.round(minutes / 60)
  if (hours < 24) return hours + ' h'

  const days = Math.round(hours / 24)
  if (days < 30) return days + ' d'

  const months = Math.round(days / 30)
  if (months < 12) return months + ' mo'

  return Math.round(days / 365) + ' y'
}

export type Correction = {
  questionId: string
  outcome: Outcome
  selectedChoiceId?: string | null
  freeTextAnswer?: string | null
}

export type CorrectionResult = {
  ok: boolean
  outcome: Outcome | null
  rescheduled: boolean
  reason: string
}

export async function correctMarkupAttempt(
  db: Db,
  userId: string,
  worksheetId: string,
  input: Correction,
): Promise<CorrectionResult> {
  const [question] = await db
    .select({id: questions.id})
    .from(questions)
    .where(
      and(eq(questions.worksheetId, worksheetId), eq(questions.id, input.questionId)),
    )
    .limit(1)

  if (!question) {
    return {ok: false, outcome: null, rescheduled: false, reason: 'no-question'}
  }

  const [existing] = await db
    .select({id: attempts.id})
    .from(attempts)
    .where(
      and(
        eq(attempts.userId, userId),
        eq(attempts.questionId, input.questionId),
        eq(attempts.source, 'markup'),
      ),
    )
    .limit(1)

  if (!existing) {
    return {ok: false, outcome: null, rescheduled: false, reason: 'not-marked'}
  }

  let choiceId: string | null = null

  if (input.selectedChoiceId) {
    const [choice] = await db
      .select({id: answerChoices.id})
      .from(answerChoices)
      .where(
        and(
          eq(answerChoices.id, input.selectedChoiceId),
          eq(answerChoices.questionId, input.questionId),
        ),
      )
      .limit(1)

    if (choice) choiceId = choice.id
  }

  let freeText: string | null = null
  if (input.freeTextAnswer) freeText = input.freeTextAnswer

  const now = new Date()
  let rescheduled = false

  await db.transaction(async (tx) => {
    await tx
      .update(attempts)
      .set({
        outcome: input.outcome,
        selectedChoiceId: choiceId,
        freeTextAnswer: freeText,
      })
      .where(eq(attempts.id, existing.id))

    const [practised] = await tx
      .select({id: attempts.id})
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

    const scheduled = scheduleFromOutcome(null, input.outcome, now)
    const card = scheduled.card

    await tx
      .insert(reviewCards)
      .values({userId, questionId: input.questionId, ...card})
      .onConflictDoUpdate({
        target: [reviewCards.userId, reviewCards.questionId],
        set: {...card, retiredAt: null},
      })

    rescheduled = true
  })

  return {ok: true, outcome: input.outcome, rescheduled, reason: ''}
}
