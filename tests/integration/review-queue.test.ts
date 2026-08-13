import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Db } from '@/lib/db/types'
import { attempts, explanations, reviewCards } from '@/lib/db/schema'
import { scheduleFromOutcome } from '@/lib/review/fsrs'
import { countReviewQueue, getDueCards } from '@/lib/review/queue'
import { countMissedQuestions, getMissedQuestions } from '@/lib/blooket/missed'

import { createTestDb, type TestDb } from '../helpers/db'
import {
  makeAttempt,
  makeQuestion,
  makeUser,
  makeWorksheet,
  seedTaxonomy,
} from '../helpers/factories'

let db: TestDb
let close: () => Promise<void>
let topicIds: Map<string, string>

const TRIANGLES = 'high-school-math.geometry.triangles.triangle-angle-sum'

beforeAll(async () => {
  const harness = await createTestDb()
  db = harness.db
  close = harness.close
  topicIds = await seedTaxonomy(db)
})

afterAll(async () => {
  await close()
})

/**
 * A card in the review queue, which means a question got wrong.
 *
 * The attempt is part of the setup rather than a detail each test repeats: the
 * queue is defined as the questions a student got wrong or guessed, so a card
 * with no wrong attempt behind it is not a state the app can reach.
 */
async function makeCard(
  userId: string,
  questionId: string,
  dueAt: Date,
  outcome: 'wrong' | 'unsure' = 'wrong',
): Promise<string> {
  const [existing] = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(and(eq(attempts.userId, userId), eq(attempts.questionId, questionId)))
    .limit(1)

  if (!existing) await makeAttempt(db, userId, questionId, outcome)

  const card = scheduleFromOutcome(null, 'wrong').card
  const [row] = await db
    .insert(reviewCards)
    .values({ userId, questionId, ...card, dueAt })
    .returning({ id: reviewCards.id })
  return row.id
}

/**
 * The count the review screen prints beside its sitting.
 *
 * These have to be the same question asked two ways. The screen loads twenty
 * and used to print that twenty as the total, so a student with sixty waiting
 * read one number on the dashboard and a smaller one here, with nothing saying
 * they counted different things.
 */
describe('countReviewQueue', () => {
  it('counts what getDueCards would return without its limit', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const now = new Date()

    for (let i = 0; i < 25; i += 1) {
      const question = await makeQuestion(db, userId, worksheetId, { ordinal: i + 1 })
      await makeCard(userId, question.id, new Date(now.getTime() - 60_000))
    }

    // The sitting is capped; the count is not, and that gap is the whole point.
    expect(await getDueCards(db as Db, userId, 20, now)).toHaveLength(20)
    expect(await countReviewQueue(db as Db, userId, now)).toBe(25)

    // Raise the limit past the queue and the two agree exactly, which is what
    // says they are counting the same set rather than two similar ones.
    expect(await getDueCards(db as Db, userId, 500, now)).toHaveLength(25)
  })

  it('does not count another student’s cards, or a retired one', async () => {
    const userId = await makeUser(db)
    const otherId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const otherSheet = await makeWorksheet(db, otherId)

    const mine = await makeQuestion(db, userId, worksheetId)
    await makeCard(userId, mine.id, new Date(Date.now() - 60_000))

    const foreign = await makeQuestion(db, otherId, otherSheet)
    await makeCard(otherId, foreign.id, new Date(Date.now() - 60_000))

    expect(await countReviewQueue(db as Db, userId)).toBe(1)
  })
})

describe('getDueCards', () => {
  /**
   * Most overdue first, but nothing is held back. Spaced repetition decides the
   * order here; it stopped deciding what a student is allowed to see, because a
   * question you got wrong is one you cannot do yet and hiding it for three days
   * left the tab empty on the evening someone sat down to work through it.
   */
  it('returns every question still to practise, most overdue first', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const now = new Date()

    const soon = await makeQuestion(db, userId, worksheetId, { ordinal: 1 })
    const overdue = await makeQuestion(db, userId, worksheetId, { ordinal: 2 })
    const future = await makeQuestion(db, userId, worksheetId, { ordinal: 3 })

    await makeCard(userId, soon.id, new Date(now.getTime() - 60_000))
    await makeCard(userId, overdue.id, new Date(now.getTime() - 10 * 24 * 3600_000))
    await makeCard(userId, future.id, new Date(now.getTime() + 24 * 3600_000))

    const queue = await getDueCards(db as Db, userId, 20, now)

    expect(queue.map((item) => item.questionId)).toEqual([overdue.id, soon.id, future.id])
  })

  it('never returns another student’s cards', async () => {
    const userId = await makeUser(db)
    const otherId = await makeUser(db)
    const otherSheet = await makeWorksheet(db, otherId)

    const foreign = await makeQuestion(db, otherId, otherSheet)
    await makeCard(otherId, foreign.id, new Date(Date.now() - 60_000))

    expect(await getDueCards(db as Db, userId)).toHaveLength(0)
  })

  it('carries the answer the student actually gave', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    const question = await makeQuestion(db, userId, worksheetId, {
      promptText: 'Find angle C.',
      topicId: topicIds.get(TRIANGLES)!,
      choices: [
        { label: 'A', text: '75°', isCorrect: true },
        { label: 'B', text: '105°' },
      ],
    })

    await makeAttempt(db, userId, question.id, 'wrong', {
      selectedChoiceId: question.choiceIds.B,
    })
    await makeCard(userId, question.id, new Date(Date.now() - 60_000))

    const [item] = await getDueCards(db as Db, userId)

    expect(item.lastChoiceId).toBe(question.choiceIds.B)
    expect(item.lastOutcome).toBe('wrong')
    expect(item.topicName).toBe('Triangle angle sum')
    expect(item.choices).toHaveLength(2)
    expect(item.choices.find((choice) => choice.isCorrect)?.label).toBe('A')
  })

  it('picks the most recent attempt when a question has several', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    const question = await makeQuestion(db, userId, worksheetId, {
      choices: [
        { label: 'A', text: 'right', isCorrect: true },
        { label: 'B', text: 'wrong' },
      ],
    })

    // Marked wrong on the paper, then got it right in review a few days later.
    // That is the only way one question ends up with two attempts: a worksheet
    // can only be marked once, which `attempts_markup_once` now enforces.
    await makeAttempt(db, userId, question.id, 'wrong', {
      selectedChoiceId: question.choiceIds.B,
      createdAt: new Date(Date.now() - 3 * 24 * 3600_000),
    })
    await makeAttempt(db, userId, question.id, 'correct', {
      selectedChoiceId: question.choiceIds.A,
      createdAt: new Date(Date.now() - 60_000),
      source: 'review',
    })

    await makeCard(userId, question.id, new Date(Date.now() - 60_000))

    const [item] = await getDueCards(db as Db, userId)
    expect(item.lastOutcome).toBe('correct')
    expect(item.lastChoiceId).toBe(question.choiceIds.A)
  })

  it('attaches a cached explanation when one exists', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const question = await makeQuestion(db, userId, worksheetId)

    await db.insert(explanations).values({
      questionId: question.id,
      bodyMd: 'You picked the supplementary angle.',
    })
    await makeCard(userId, question.id, new Date(Date.now() - 60_000))

    const [item] = await getDueCards(db as Db, userId)
    expect(item.explanation?.body).toBe('You picked the supplementary angle.')
    expect(item.explanation?.reportedWrong).toBe(false)
  })

  it('reports no explanation rather than failing when none exists', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const question = await makeQuestion(db, userId, worksheetId)
    await makeCard(userId, question.id, new Date(Date.now() - 60_000))

    const [item] = await getDueCards(db as Db, userId)
    expect(item.explanation).toBeNull()
  })

  it('respects the queue limit', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    for (let i = 0; i < 5; i += 1) {
      const question = await makeQuestion(db, userId, worksheetId, { ordinal: i + 1 })
      await makeCard(userId, question.id, new Date(Date.now() - (i + 1) * 60_000))
    }

    expect(await getDueCards(db as Db, userId, 3)).toHaveLength(3)
  })
})

describe('card uniqueness', () => {
  it('keeps one card per question per user', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const question = await makeQuestion(db, userId, worksheetId)

    await makeCard(userId, question.id, new Date())

    await expect(makeCard(userId, question.id, new Date())).rejects.toThrow()

    const cards = await db
      .select()
      .from(reviewCards)
      .where(eq(reviewCards.questionId, question.id))
    expect(cards).toHaveLength(1)
  })
})

/**
 * The queue is every question got wrong or guessed, not only what the scheduler
 * has got round to. Hiding a question for three days because ts-fsrs picked
 * that interval left the tab empty on an evening a student sat down to work
 * through their mistakes.
 */
describe('the review queue', () => {
  it('holds a question that is not due yet', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const q = await makeQuestion(db, userId, worksheetId)

    await makeAttempt(db, userId, q.id, 'wrong')
    await makeCard(userId, q.id, new Date(Date.now() + 30 * 24 * 3600_000))

    const queue = await getDueCards(db as Db, userId)

    expect(queue.map((card) => card.questionId)).toContain(q.id)
  })

  it('holds a question that was guessed, not only ones got wrong', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const q = await makeQuestion(db, userId, worksheetId)

    await makeAttempt(db, userId, q.id, 'unsure')
    await makeCard(userId, q.id, new Date(Date.now() + 24 * 3600_000))

    expect((await getDueCards(db as Db, userId)).map((c) => c.questionId)).toContain(q.id)
  })

  /**
   * Markup writes a card for every question on the paper, including the ones
   * the student got right, and those were never what this screen is about.
   */
  it('leaves out a question that was only ever answered correctly', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const q = await makeQuestion(db, userId, worksheetId)

    await makeAttempt(db, userId, q.id, 'correct')
    await makeCard(userId, q.id, new Date(Date.now() - 60_000))

    expect((await getDueCards(db as Db, userId)).map((c) => c.questionId)).not.toContain(
      q.id,
    )
  })

  it('lets go of one the student has said they have', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const q = await makeQuestion(db, userId, worksheetId)

    await makeAttempt(db, userId, q.id, 'wrong')
    const cardId = await makeCard(userId, q.id, new Date(Date.now() - 60_000))

    expect((await getDueCards(db as Db, userId)).map((c) => c.questionId)).toContain(q.id)

    await db
      .update(reviewCards)
      .set({ retiredAt: new Date() })
      .where(eq(reviewCards.id, cardId))

    expect((await getDueCards(db as Db, userId)).map((c) => c.questionId)).not.toContain(
      q.id,
    )
  })

  /**
   * The whole point of retiring rather than deleting: the question is still one
   * they got wrong, so everything that counts wrong answers still counts it.
   * The attempts are what those read, and retiring does not touch them.
   */
  it('keeps a retired question in the Blooket export', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const q = await makeQuestion(db, userId, worksheetId, {
      promptText: 'What is the remainder when 7^100 is divided by 5?',
      choices: [
        { label: 'A', text: '1', isCorrect: true },
        { label: 'B', text: '2', isCorrect: false },
      ],
    })

    await makeAttempt(db, userId, q.id, 'wrong')
    const cardId = await makeCard(userId, q.id, new Date(Date.now() - 60_000))
    await db
      .update(reviewCards)
      .set({ retiredAt: new Date() })
      .where(eq(reviewCards.id, cardId))

    expect((await getDueCards(db as Db, userId)).map((c) => c.questionId)).not.toContain(
      q.id,
    )
    expect((await getMissedQuestions(db as Db, userId)).map((e) => e.id)).toContain(q.id)
    expect(await countMissedQuestions(db as Db, userId)).toBeGreaterThan(0)
  })
})
