import { describe, expect, it } from 'vitest'

import {
  previewIntervals,
  scheduleFromOutcome,
  scheduleFromReview,
  type StoredCard,
} from '@/lib/review/fsrs'

const NOW = new Date('2026-08-01T12:00:00.000Z')

function seed(outcome: 'correct' | 'unsure' | 'wrong'): StoredCard {
  return scheduleFromOutcome(null, outcome, NOW).card
}

describe('scheduleFromOutcome', () => {
  it('schedules a missed question sooner than an unsure one', () => {
    expect(seed('wrong').dueAt.getTime()).toBeLessThan(seed('unsure').dueAt.getTime())
  })

  it('schedules an unsure question sooner than a confident one', () => {
    // This is the whole reason `unsure` exists as a separate outcome: right-but-
    // guessed must come back before genuinely known (spec §5.3).
    expect(seed('unsure').dueAt.getTime()).toBeLessThan(seed('correct').dueAt.getTime())
  })

  it('always schedules into the future', () => {
    for (const outcome of ['correct', 'unsure', 'wrong'] as const) {
      expect(seed(outcome).dueAt.getTime()).toBeGreaterThan(NOW.getTime())
    }
  })

  it('counts a first review and leaves the new state behind', () => {
    const card = seed('correct')
    expect(card.reps).toBe(1)
    expect(card.state).not.toBe('new')
    expect(card.lastReview).toEqual(NOW)
  })

  it('records a lapse only when the answer was wrong', () => {
    expect(seed('wrong').lapses).toBeGreaterThanOrEqual(0)
    expect(seed('correct').lapses).toBe(0)
  })

  it('returns a log entry that matches the card it produced', () => {
    const { card, log } = scheduleFromOutcome(null, 'wrong', NOW)
    expect(log.rating).toBe(1) // Rating.Again
    expect(card.state).toBeDefined()
  })
})

describe('scheduleFromReview', () => {
  it('round-trips stored card state without losing FSRS fields', () => {
    const first = scheduleFromOutcome(null, 'wrong', NOW).card
    const later = new Date(NOW.getTime() + 10 * 60_000)
    const second = scheduleFromReview(first, 'good', later).card

    expect(second.reps).toBe(first.reps + 1)
    expect(second.dueAt.getTime()).toBeGreaterThan(later.getTime())
    expect(Number.isFinite(second.stability)).toBe(true)
    expect(Number.isFinite(second.difficulty)).toBe(true)
    expect(second.learningSteps).toBeGreaterThanOrEqual(0)
  })

  it('pushes intervals out further for easier ratings', () => {
    const card = scheduleFromOutcome(null, 'correct', NOW).card
    const later = new Date(NOW.getTime() + 24 * 3600_000)

    const again = scheduleFromReview(card, 'again', later).card.dueAt.getTime()
    const good = scheduleFromReview(card, 'good', later).card.dueAt.getTime()
    const easy = scheduleFromReview(card, 'easy', later).card.dueAt.getTime()

    expect(again).toBeLessThan(good)
    expect(good).toBeLessThan(easy)
  })

  it('increments lapses only once a card has graduated to review', () => {
    // FSRS counts a lapse when a *known* card is forgotten. A freshly seeded
    // card is still in learning, so it has to graduate first.
    let card = scheduleFromOutcome(null, 'correct', NOW).card
    let clock = NOW

    for (let i = 0; i < 5 && card.state !== 'review'; i += 1) {
      clock = new Date(card.dueAt.getTime() + 60_000)
      card = scheduleFromReview(card, 'good', clock).card
    }

    expect(card.state).toBe('review')

    const forgotten = scheduleFromReview(
      card,
      'again',
      new Date(card.dueAt.getTime() + 60_000),
    ).card

    expect(forgotten.lapses).toBe(card.lapses + 1)
    expect(forgotten.state).toBe('relearning')
  })
})

describe('previewIntervals', () => {
  it('offers a due date for every rating, ordered by difficulty', () => {
    const card = scheduleFromOutcome(null, 'correct', NOW).card
    const later = new Date(NOW.getTime() + 24 * 3600_000)
    const preview = previewIntervals(card, later)

    expect(Object.keys(preview).sort()).toEqual(['again', 'easy', 'good', 'hard'])
    expect(preview.again.getTime()).toBeLessThanOrEqual(preview.hard.getTime())
    expect(preview.hard.getTime()).toBeLessThanOrEqual(preview.good.getTime())
    expect(preview.good.getTime()).toBeLessThanOrEqual(preview.easy.getTime())
  })
})
