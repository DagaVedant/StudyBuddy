import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { toBlooketCsv } from '@/lib/blooket/csv'
import { countMissedQuestions, getMissedQuestions } from '@/lib/blooket/missed'
import { questions } from '@/lib/db/schema'

import { asDb, createTestDb, type TestDb } from '../helpers/db'
import { makeAttempt, makeQuestion, makeUser, makeWorksheet } from '../helpers/factories'

let db: TestDb
let close: () => Promise<void>

beforeAll(async () => {
  const harness = await createTestDb()
  db = harness.db
  close = harness.close
})

afterAll(async () => {
  await close()
})

const FOUR = [
  { label: 'A', text: 'Four' },
  { label: 'B', text: 'Five' },
  { label: 'C', text: 'Six', isCorrect: true },
  { label: 'D', text: 'Seven' },
]

describe('getMissedQuestions', () => {
  it('returns the ones got wrong or guessed, and leaves the rest alone', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    const wrong = await makeQuestion(db, userId, worksheetId, {
      ordinal: 1,
      promptText: 'What is the sum of the angles in a triangle?',
      choices: FOUR,
    })
    const right = await makeQuestion(db, userId, worksheetId, {
      ordinal: 2,
      promptText: 'What is the area of a unit square?',
      choices: FOUR,
    })
    const unsure = await makeQuestion(db, userId, worksheetId, {
      ordinal: 3,
      promptText: 'What is the perimeter of that same square?',
      choices: FOUR,
    })

    await makeAttempt(db, userId, wrong.id, 'wrong')
    await makeAttempt(db, userId, right.id, 'correct')
    await makeAttempt(db, userId, unsure.id, 'unsure')

    const missed = await getMissedQuestions(asDb(db), userId)

    expect(missed.map((question) => question.id)).toEqual([wrong.id, unsure.id])
    expect(await countMissedQuestions(asDb(db), userId)).toBe(2)

    expect(missed.map((question) => question.id)).not.toContain(right.id)
  })

  it('returns a question once however many times it was answered', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    const question = await makeQuestion(db, userId, worksheetId, { choices: FOUR })

    await makeAttempt(db, userId, question.id, 'wrong')
    await makeAttempt(db, userId, question.id, 'wrong', { source: 'review' })
    await makeAttempt(db, userId, question.id, 'wrong', { source: 'review' })

    const missed = await getMissedQuestions(asDb(db), userId)

    expect(missed).toHaveLength(1)
    expect(await countMissedQuestions(asDb(db), userId)).toBe(1)
  })

  it('keeps one that was missed first and got right later', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    const question = await makeQuestion(db, userId, worksheetId, { choices: FOUR })

    await makeAttempt(db, userId, question.id, 'wrong')
    await makeAttempt(db, userId, question.id, 'correct', { source: 'review' })

    expect(await countMissedQuestions(asDb(db), userId)).toBe(1)
  })

  it('never reaches into another account', async () => {
    const mine = await makeUser(db)
    const theirs = await makeUser(db)
    const worksheetId = await makeWorksheet(db, theirs)

    const question = await makeQuestion(db, theirs, worksheetId, { choices: FOUR })
    await makeAttempt(db, theirs, question.id, 'wrong')

    expect(await getMissedQuestions(asDb(db), mine)).toEqual([])
    expect(await countMissedQuestions(asDb(db), mine)).toBe(0)
  })

  it('carries the choices in label order, which is what the answer numbers mean', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    const question = await makeQuestion(db, userId, worksheetId, {
      promptText: 'How many sides does a hexagon have?',
      choices: [
        { label: 'C', text: 'Six', isCorrect: true },
        { label: 'A', text: 'Four' },
        { label: 'D', text: 'Seven' },
        { label: 'B', text: 'Five' },
      ],
    })
    await makeAttempt(db, userId, question.id, 'wrong')

    const [missed] = await getMissedQuestions(asDb(db), userId)

    expect(missed.choices.map((choice) => choice.label)).toEqual(['A', 'B', 'C', 'D'])

    const { csv } = toBlooketCsv([missed])
    const row = csv.trimEnd().split('\r\n')[2]

    expect(row).toBe('1,How many sides does a hexagon have?,Four,Five,Six,Seven,30,3,,')
  })

  it('exports a terse question the dashboard declines to count', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    const terse = await makeQuestion(db, userId, worksheetId, {
      promptText: 'Solve for x.',
      choices: FOUR,
    })
    await makeAttempt(db, userId, terse.id, 'wrong')

    const missed = await getMissedQuestions(asDb(db), userId)

    expect(missed.map((question) => question.promptText)).toEqual(['Solve for x.'])
  })

  it('leaves out page furniture, because it has no answer key', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    const furniture = await makeQuestion(db, userId, worksheetId, {
      promptText: 'CONTINUE TO THE NEXT PAGE',
    })
    await makeAttempt(db, userId, furniture.id, 'wrong')

    const { included, skipped } = toBlooketCsv(await getMissedQuestions(asDb(db), userId))

    expect(included).toBe(0)
    expect(skipped).toEqual([{ questionId: furniture.id, reason: 'no-answer' }])
  })

  it('exports a free response question once its answer key is known', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    const question = await makeQuestion(db, userId, worksheetId, {
      promptText: 'What is the greatest common factor of 18 and 24?',
    })
    await makeAttempt(db, userId, question.id, 'wrong')

    expect(toBlooketCsv(await getMissedQuestions(asDb(db), userId)).included).toBe(0)

    await db
      .update(questions)
      .set({ correctAnswer: '6', answerSource: 'user_key' })
      .where(eq(questions.id, question.id))

    const { csv, included } = toBlooketCsv(await getMissedQuestions(asDb(db), userId))

    expect(included).toBe(1)
    expect(csv.trimEnd().split('\r\n')[2]).toBe(
      '1,What is the greatest common factor of 18 and 24?,6,,,,30,1,,typing',
    )
  })

  it('narrows to one paper when a worksheet is named', async () => {
    const userId = await makeUser(db)
    const algebra = await makeWorksheet(db, userId, 'Algebra Unit 3')
    const geometry = await makeWorksheet(db, userId, 'Geometry Unit 1')

    const inAlgebra = await makeQuestion(db, userId, algebra, {
      promptText: 'What is the value of x when 3x equals 12?',
      choices: FOUR,
    })
    const inGeometry = await makeQuestion(db, userId, geometry, {
      promptText: 'How many degrees are in a right angle?',
      choices: FOUR,
    })

    await makeAttempt(db, userId, inAlgebra.id, 'wrong')
    await makeAttempt(db, userId, inGeometry.id, 'wrong')

    const scoped = await getMissedQuestions(asDb(db), userId, { worksheetId: algebra })

    expect(scoped.map((question) => question.id)).toEqual([inAlgebra.id])
    expect(await countMissedQuestions(asDb(db), userId, algebra)).toBe(1)

    expect(await countMissedQuestions(asDb(db), userId)).toBe(2)
  })

  it('returns nothing for a worksheet belonging to somebody else', async () => {
    const mine = await makeUser(db)
    const theirs = await makeUser(db)
    const worksheetId = await makeWorksheet(db, theirs, 'Not mine')

    const question = await makeQuestion(db, theirs, worksheetId, { choices: FOUR })
    await makeAttempt(db, theirs, question.id, 'wrong')

    expect(await getMissedQuestions(asDb(db), mine, { worksheetId })).toEqual([])
    expect(await countMissedQuestions(asDb(db), mine, worksheetId)).toBe(0)
  })

  it('reads in the order the questions were printed, not the order they were marked', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId, 'October paper')

    const second = await makeQuestion(db, userId, worksheetId, {
      ordinal: 2,
      promptText: 'Which of these numbers is prime?',
      choices: FOUR,
    })
    const first = await makeQuestion(db, userId, worksheetId, {
      ordinal: 1,
      promptText: 'Which of these numbers is even?',
      choices: FOUR,
    })

    await makeAttempt(db, userId, second.id, 'wrong')
    await makeAttempt(db, userId, first.id, 'wrong')

    const missed = await getMissedQuestions(asDb(db), userId)

    expect(missed.map((question) => question.id)).toEqual([first.id, second.id])
  })
})
