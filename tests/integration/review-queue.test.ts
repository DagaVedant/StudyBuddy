import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Db } from '@/lib/db/types'
import { explanations, reviewCards } from '@/lib/db/schema'
import { scheduleFromOutcome } from '@/lib/review/fsrs'
import { getDueCards } from '@/lib/review/queue'

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

async function makeCard(
  userId: string,
  questionId: string,
  dueAt: Date,
): Promise<string> {
  const card = scheduleFromOutcome(null, 'wrong').card
  const [row] = await db
    .insert(reviewCards)
    .values({ userId, questionId, ...card, dueAt })
    .returning({ id: reviewCards.id })
  return row.id
}

describe('getDueCards', () => {
  it('returns only cards that are actually due, most overdue first', async () => {
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

    expect(queue.map((item) => item.questionId)).toEqual([overdue.id, soon.id])
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
