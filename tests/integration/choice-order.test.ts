import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { answerChoices, reviewCards } from '@/lib/db/schema'
import { loadQuestionsWithChoices } from '@/lib/questions/load'
import { getMissedQuestions } from '@/lib/blooket/missed'
import { scheduleFromOutcome } from '@/lib/review/fsrs'
import { getDueCards } from '@/lib/review/queue'

import { asDb, createTestDb, type TestDb } from '../helpers/db'
import { makeAttempt, makeQuestion, makeUser, makeWorksheet } from '../helpers/factories'

let db: TestDb
let close: () => Promise<void>

beforeAll(async () => {
  const created = await createTestDb()
  db = created.db
  close = created.close
})

afterAll(async () => {
  await close()
})

const FOUR = [
  { label: 'A', text: '1', isCorrect: false },
  { label: 'B', text: '2', isCorrect: false },
  { label: 'C', text: '3', isCorrect: false },
  { label: 'D', text: '4', isCorrect: true },
]

/**
 * There is no position column: the label is the position. Eight places loaded a
 * question's options and one of them said so, which is how the markup screen
 * came to offer "B 2, C 3, D 4, A 1" for a question whose paper prints A first.
 *
 * Postgres will not reproduce that on demand, so these seed the rows in a
 * deliberately wrong physical order and then ask each reader for them. Without
 * an `order by`, a small table is returned in insertion order, so a reader that
 * has forgotten one fails here.
 */
async function questionWithScrambledChoices(userId: string, worksheetId: string) {
  const { id, choiceIds } = await makeQuestion(db, userId, worksheetId, {
    ordinal: 1,
    promptText: 'What is the remainder when 7^100 is divided by 5?',
    choices: FOUR,
  })

  // Rewrite the rows in the order B, C, D, A, which is what the screenshot
  // showed and what an unordered read hands back.
  await db.delete(answerChoices).where(sql`${answerChoices.questionId} = ${id}`)
  for (const label of ['B', 'C', 'D', 'A']) {
    const choice = FOUR.find((option) => option.label === label)!
    await db.insert(answerChoices).values({
      questionId: id,
      label: choice.label,
      text: choice.text,
      isCorrect: choice.isCorrect,
    })
  }

  return { id, choiceIds }
}

describe('a question whose options are stored out of order', () => {
  it('is loaded A to D by the shared loader', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    await questionWithScrambledChoices(userId, worksheetId)

    const [question] = await loadQuestionsWithChoices(asDb(db), worksheetId)

    expect(question.choices.map((choice) => choice.label)).toEqual(['A', 'B', 'C', 'D'])
  })

  it('is exported to Blooket A to D, since the answer is written as a position', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const question = await questionWithScrambledChoices(userId, worksheetId)
    await makeAttempt(db, userId, question.id, 'wrong')

    const [exported] = await getMissedQuestions(asDb(db), userId)

    expect(exported.choices.map((choice) => choice.label)).toEqual(['A', 'B', 'C', 'D'])
    // D is the correct one, and it has to still be the fourth thing written or
    // the answer number points at somebody else's option.
    expect(exported.choices.findIndex((choice) => choice.isCorrect)).toBe(3)
  })

  it('is asked A to D in the review queue', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const question = await questionWithScrambledChoices(userId, worksheetId)
    await makeAttempt(db, userId, question.id, 'wrong')
    await db.insert(reviewCards).values({
      userId,
      questionId: question.id,
      ...scheduleFromOutcome(null, 'wrong').card,
      dueAt: new Date(Date.now() - 60_000),
    })

    const queue = await getDueCards(asDb(db), userId)
    const card = queue.find((entry) => entry.questionId === question.id)

    expect(card).toBeDefined()
    expect(card!.choices.map((choice) => choice.label)).toEqual(['A', 'B', 'C', 'D'])
  })
})
