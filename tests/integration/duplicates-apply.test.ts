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

/**
 * A real question with alphabetic choices, and the phantom row the extractor
 * built from the same material with numeric labels. The phantom's option text
 * is a verbatim substring of the matching real option, which is what
 * `choicesAreContainedIn` requires to tell a phantom from a genuinely
 * different question that happens to share a stem.
 */
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

/**
 * Nothing tested this function before. It deletes rows, which makes the
 * absence worse than usual: the number-collision bug this file was written to
 * cover shipped, ran on production, and nothing here would have caught it.
 */
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

  /*
   * The bug. `planDuplicateMerges` hands the survivor `Math.min` of the
   * pair's two numbers with no view of the rest of the worksheet, so the
   * number it picks can belong to a third row neither plan mentions. Renumber
   * the survivor anyway and the worksheet ends up with two rows both
   * claiming 5, which is the exact state a duplicate-number repair pass would
   * then try to fix by deleting one of them.
   */
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
    // Nothing moved. The duplicate stays visible for the student to resolve
    // rather than the fix silently creating a second row numbered 5.
    expect(await exists(phantomId)).toBe(true)
    expect(await numberOf(realId)).toBe(9)
    expect(await numberOf(unrelated.id)).toBe(5)
  })

  // The phantom holding the target number is not a third row: it is the
  // source of that number, and merging into it is the whole point.
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

  /*
   * Two independent pairs on one worksheet, engineered so both phantoms
   * genuinely hold the same number before either plan runs. Letting either
   * one through would still leave a collision: the untouched phantom keeps 5
   * while the renumbered survivor also becomes 5, because the page really
   * did print "5" twice on two unrelated questions. No ordering resolves
   * that safely, so both plans are refused rather than guessing which one
   * gets to keep the number.
   */
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

    // Neither merge applies. Both phantoms are left for a person to look at,
    // which is the safe failure: nothing was deleted and nothing was
    // renumbered onto a number another live row already holds.
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
