import {
  createEmptyCard,
  fsrs,
  Rating,
  State,
  type Card,
  type Grade,
} from 'ts-fsrs'

/**
 * FSRS scheduling (spec §5.4). The DB stores card state as flat columns rather
 * than a blob so the review queue can be a plain indexed `due_at` query.
 */

const scheduler = fsrs()

export type Outcome = 'correct' | 'unsure' | 'wrong'
export type CardStateName = 'new' | 'learning' | 'review' | 'relearning'

const STATE_NAMES: CardStateName[] = ['new', 'learning', 'review', 'relearning']

/**
 * `unsure` maps to Hard rather than Good on purpose: a right-but-guessed
 * answer should come back sooner than one the student actually knew.
 */
const GRADE_BY_OUTCOME: Record<Outcome, Grade> = {
  wrong: Rating.Again,
  unsure: Rating.Hard,
  correct: Rating.Good,
}

/** Review-session ratings map straight through to FSRS grades. */
export const REVIEW_GRADES = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
} as const satisfies Record<string, Grade>

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
  return STATE_NAMES[state] ?? 'new'
}

function toStateValue(name: CardStateName): State {
  const index = STATE_NAMES.indexOf(name)
  return (index < 0 ? State.New : index) as State
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
  const { card, log } = scheduler.next(toFsrsCard(stored, now), now, grade)

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

/** First scheduling, driven by how the student did on the worksheet itself. */
export function scheduleFromOutcome(
  stored: StoredCard | null,
  outcome: Outcome,
  now: Date = new Date(),
): ScheduleResult {
  return schedule(stored, GRADE_BY_OUTCOME[outcome], now)
}

/** Subsequent scheduling, driven by the student's recall rating in review. */
export function scheduleFromReview(
  stored: StoredCard,
  rating: ReviewRating,
  now: Date = new Date(),
): ScheduleResult {
  return schedule(stored, REVIEW_GRADES[rating], now)
}

/** Preview of the next interval per rating, for labelling the review buttons. */
export function previewIntervals(
  stored: StoredCard,
  now: Date = new Date(),
): Record<ReviewRating, Date> {
  const entries = Object.entries(REVIEW_GRADES) as [ReviewRating, Grade][]
  return Object.fromEntries(
    entries.map(([name, grade]) => [
      name,
      scheduler.next(toFsrsCard(stored, now), now, grade).card.due,
    ]),
  ) as Record<ReviewRating, Date>
}
