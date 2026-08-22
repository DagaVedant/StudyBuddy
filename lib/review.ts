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
  explanation: {body: string; reportedWrong: boolean} | null
  evidence: QuestionEvidence | null
  dueAt: string
  intervals: Record<ReviewRating, string>
}

export async function countReviewQueue(
  db: Db,
  userId: string,
  now: Date = new Date(),
  topicId?: string | null,
): Promise<number> {
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
        ? {body: explanation.bodyMd, reportedWrong: explanation.reportedWrong}
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

const scheduler = fsrs()

export type Outcome = 'correct' | 'unsure' | 'wrong'
export type CardStateName = 'new' | 'learning' | 'review' | 'relearning'

const STATE_NAMES: CardStateName[] = ['new', 'learning', 'review', 'relearning']

const GRADE_BY_OUTCOME: Record<Outcome, Grade> = {
  wrong: Rating.Again,
  unsure: Rating.Hard,
  correct: Rating.Good,
}

const REVIEW_GRADES = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
} as const

export type ReviewRating = keyof typeof REVIEW_GRADES

export interface StoredCard {
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

export interface ScheduleResult {
  card: StoredCard
  log: {
    rating: number
    state: CardStateName
    elapsedDays: number
    scheduledDays: number
  }
}

function toStateName(state: State): CardStateName {
  return STATE_NAMES[state]
}

function toStateValue(name: CardStateName): State {
  return STATE_NAMES.indexOf(name) as State
}

function toFsrsCard(stored: StoredCard | null, now: Date): Card {
  if (!stored) return createEmptyCard(now)

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
    last_review: stored.lastReview ?? undefined,
  }
}

function fromFsrsCard(card: Card): StoredCard {
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
    lastReview: card.last_review ?? null,
  }
}

function schedule(
  stored: StoredCard | null,
  grade: Grade,
  now: Date,
): ScheduleResult {
  const {card, log} = scheduler.next(toFsrsCard(stored, now), now, grade)

  return {
    card: fromFsrsCard(card),
    log: {
      rating: log.rating,
      state: toStateName(log.state),
      elapsedDays: log.elapsed_days,
      scheduledDays: log.scheduled_days,
    },
  }
}

export function scheduleFromOutcome(
  stored: StoredCard | null,
  outcome: Outcome,
  now: Date = new Date(),
): ScheduleResult {
  return schedule(stored, GRADE_BY_OUTCOME[outcome], now)
}

export function scheduleFromReview(
  stored: StoredCard,
  rating: ReviewRating,
  now: Date = new Date(),
): ScheduleResult {
  return schedule(stored, REVIEW_GRADES[rating], now)
}

function previewIntervals(
  stored: StoredCard,
  now: Date = new Date(),
): Record<ReviewRating, Date> {
  const dueAfter = (grade: Grade) =>
    scheduler.next(toFsrsCard(stored, now), now, grade).card.due

  return {
    again: dueAfter(REVIEW_GRADES.again),
    hard: dueAfter(REVIEW_GRADES.hard),
    good: dueAfter(REVIEW_GRADES.good),
    easy: dueAfter(REVIEW_GRADES.easy),
  }
}

function formatInterval(due: Date, now: Date = new Date()): string {
  const minutes = Math.round((due.getTime() - now.getTime()) / 60_000)

  if (minutes < 1) return '<1 min'
  if (minutes < 60) return `${minutes} min`

  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h`

  const days = Math.round(hours / 24)
  if (days < 30) return `${days} d`

  const months = Math.round(days / 30)
  if (months < 12) return `${months} mo`

  return `${Math.round(days / 365)} y`
}

export interface Correction {
  questionId: string
  outcome: Outcome
  selectedChoiceId?: string | null
  freeTextAnswer?: string | null
}

export type CorrectionResult =
  | {ok: true; outcome: Outcome; rescheduled: boolean}
  | {ok: false; reason: 'no-question' | 'not-marked'}

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

  if (!question) return {ok: false, reason: 'no-question'}

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

  if (!existing) return {ok: false, reason: 'not-marked'}

  const [choice] = input.selectedChoiceId
    ? await db
        .select({id: answerChoices.id})
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

    const {card} = scheduleFromOutcome(null, input.outcome, now)

    await tx
      .insert(reviewCards)
      .values({userId, questionId: input.questionId, ...card})
      .onConflictDoUpdate({
        target: [reviewCards.userId, reviewCards.questionId],
        set: {...card, retiredAt: null},
      })

    rescheduled = true
  })

  return {ok: true, outcome: input.outcome, rescheduled}
}
