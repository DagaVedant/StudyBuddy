import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Db } from '@/lib/db/types'
import { questions } from '@/lib/db/schema'
import { mergeDuplicateQuestions } from '@/lib/worker/duplicates-apply'

import { createTestDb, type TestDb } from '../helpers/db'
import { makeQuestion, makeUser, makeWorksheet } from '../helpers/factories'

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

const client = () => db as unknown as Db

async function setNumber(id: string, printedNumber: number): Promise<void> {
  await db.update(questions).set({ printedNumber }).where(eq(questions.id, id))
}

async function exists(id: string): Promise<boolean> {
  const rows = await db.select({ id: questions.id }).from(questions).where(eq(questions.id, id))
  return rows.length > 0
}

async function numberOf(id: string): Promise<number | null> {
  const [row] = await db
    .select({ printedNumber: questions.printedNumber })
    .from(questions)
    .where(eq(questions.id, id))
  return row?.printedNumber ?? null
}

const PROMPT = 'Which of the following is a prime number?'

async function makePhantomPair(
  userId: string,
  worksheetId: string,
): Promise<{ realId: string; phantomId: string }> {
  const real = await makeQuestion(db, userId, worksheetId, {
    promptText: PROMPT,
    choices: [
      { label: 'A', text: 'The number 2 is a prime that is also even and small' },
      { label: 'B', text: 'The number 4 is composite' },
      { label: 'C', text: 'The number 9 is composite too' },
      { label: 'D', text: 'The number 11 is a prime as well' },
    ],
  })

  const phantom = await makeQuestion(db, userId, worksheetId, {
    promptText: PROMPT,
    choices: [
      { label: '1', text: 'is a prime that' },
      { label: '2', text: '4 is composite' },
      { label: '3', text: '9 is composite too' },
      { label: '4', text: '11 is a prime as well' },
    ],
  })

  return { realId: real.id, phantomId: phantom.id }
}

describe('mergeDuplicateQuestions', () => {
  it('folds a phantom into the real question and recovers its number', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const { realId, phantomId } = await makePhantomPair(userId, worksheetId)

    await setNumber(realId, 9)
    await setNumber(phantomId, 5)

    const result = await mergeDuplicateQuestions(client(), worksheetId)

    expect(result.merged).toBe(1)
    expect(await exists(phantomId)).toBe(false)
    expect(await exists(realId)).toBe(true)
    expect(await numberOf(realId)).toBe(5)
  })

  it('refuses to renumber onto a number a third row already holds', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const { realId, phantomId } = await makePhantomPair(userId, worksheetId)

    await setNumber(realId, 9)
    await setNumber(phantomId, 5)

    const unrelated = await makeQuestion(db, userId, worksheetId, {
      promptText: 'What is the capital of France?',
    })
    await setNumber(unrelated.id, 5)

    const result = await mergeDuplicateQuestions(client(), worksheetId)

    expect(result.merged).toBe(0)
    expect(await exists(phantomId)).toBe(true)
    expect(await numberOf(realId)).toBe(9)
    expect(await numberOf(unrelated.id)).toBe(5)
  })

  it('does not treat the phantom itself as a collision', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const { realId, phantomId } = await makePhantomPair(userId, worksheetId)

    await setNumber(realId, 3)
    await setNumber(phantomId, 3)

    const result = await mergeDuplicateQuestions(client(), worksheetId)

    expect(result.merged).toBe(1)
    expect(await numberOf(realId)).toBe(3)
  })

  it('refuses both merges when two unrelated phantoms genuinely share a number', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    const pairA = await makeQuestion(db, userId, worksheetId, {
      promptText: 'Solve for x: 2x + 4 = 10',
      choices: [
        { label: 'A', text: 'Subtract four from both sides to get two x equals six' },
        { label: 'B', text: 'Divide by two on both sides to isolate x completely' },
      ],
    })
    const phantomA = await makeQuestion(db, userId, worksheetId, {
      promptText: 'Solve for x: 2x + 4 = 10',
      choices: [
        { label: '1', text: 'both sides to get two x equals six' },
        { label: '2', text: 'both sides to isolate x completely' },
      ],
    })
    await setNumber(pairA.id, 12)
    await setNumber(phantomA.id, 5)

    const pairB = await makeQuestion(db, userId, worksheetId, {
      promptText: 'Solve for y: 3y - 6 = 9',
      choices: [
        { label: 'A', text: 'Add six to both sides to get three y equals fifteen' },
        { label: 'B', text: 'Divide by three on both sides to isolate y' },
      ],
    })
    const phantomB = await makeQuestion(db, userId, worksheetId, {
      promptText: 'Solve for y: 3y - 6 = 9',
      choices: [
        { label: '1', text: 'both sides to get three y equals fifteen' },
        { label: '2', text: 'both sides to isolate y' },
      ],
    })
    await setNumber(pairB.id, 20)
    await setNumber(phantomB.id, 5)

    const result = await mergeDuplicateQuestions(client(), worksheetId)

    expect(result.merged).toBe(0)
    expect(await exists(phantomA.id)).toBe(true)
    expect(await exists(phantomB.id)).toBe(true)
    expect(await numberOf(pairA.id)).toBe(12)
    expect(await numberOf(pairB.id)).toBe(20)
  })

  it('does nothing on a worksheet with no duplicates', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const only = await makeQuestion(db, userId, worksheetId, { promptText: 'Solo question' })
    await setNumber(only.id, 1)

    const result = await mergeDuplicateQuestions(client(), worksheetId)

    expect(result.merged).toBe(0)
    expect(await exists(only.id)).toBe(true)
  })
})
