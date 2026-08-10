import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { attempts, questions, reviewCards } from '@/lib/db/schema'
import { mergeDuplicateQuestions } from '@/lib/worker/duplicates-apply'
import { joinSplitQuestions } from '@/lib/worker/join-splits'

import { asDb, createTestDb, type TestDb } from '../helpers/db'
import { makeUser, makeWorksheet } from '../helpers/factories'

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

const client = () => asDb(db)

/** The pair the merge exists to fold: one printed number, two rows. */
async function seedDuplicatePair(userId: string, worksheetId: string) {
  const prompt = 'A rectangular garden measures 12 m by 8 m. What is its area?'

  const rows = []
  for (const ordinal of [1, 2]) {
    const [row] = await db
      .insert(questions)
      .values({
        userId,
        worksheetId,
        ordinal,
        printedNumber: 1,
        promptText: prompt,
        questionType: 'multiple_choice',
      })
      .returning({ id: questions.id })
    rows.push(row.id)
  }

  return rows
}

describe('the repair passes and a student’s work', () => {
  // The assumption the passes used to carry: nothing downstream points at
  // these rows, because the student has not reached markup. True of a first
  // run, false of every re-run, and `questions` cascades to attempts and
  // review cards, so the deletion took both with it and said nothing.
  it('does not merge away a question the student has answered', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const [first, second] = await seedDuplicatePair(userId, worksheetId)

    // Against both, so whichever the planner picks to drop is protected.
    for (const questionId of [first, second]) {
      await db.insert(attempts).values({
        userId,
        questionId,
        outcome: 'wrong',
        source: 'markup',
      })
    }

    const { merged } = await mergeDuplicateQuestions(client(), worksheetId)

    expect(merged).toBe(0)

    const left = await db
      .select({ id: questions.id })
      .from(questions)
      .where(eq(questions.worksheetId, worksheetId))
    expect(left).toHaveLength(2)

    const kept = await db.select({ id: attempts.id }).from(attempts)
    expect(kept).toHaveLength(2)
  })

  it('still merges when nothing points at the row', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    await seedDuplicatePair(userId, worksheetId)

    const { merged } = await mergeDuplicateQuestions(client(), worksheetId)

    expect(merged).toBe(1)

    const left = await db
      .select({ id: questions.id })
      .from(questions)
      .where(eq(questions.worksheetId, worksheetId))
    expect(left).toHaveLength(1)
  })

  // A review card is the other thing that cascades, and it is the one the
  // student cannot rebuild: it carries the whole revision schedule.
  it('does not merge away a question that carries a review card', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const [first, second] = await seedDuplicatePair(userId, worksheetId)

    for (const questionId of [first, second]) {
      await db.insert(reviewCards).values({
        userId,
        questionId,
        dueAt: new Date(),
      })
    }

    const { merged } = await mergeDuplicateQuestions(client(), worksheetId)

    expect(merged).toBe(0)
    expect(await db.select({ id: reviewCards.id }).from(reviewCards)).toHaveLength(2)
  })

  it('leaves a split half alone once it has been answered', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const [first, second] = await seedDuplicatePair(userId, worksheetId)

    for (const questionId of [first, second]) {
      await db.insert(attempts).values({
        userId,
        questionId,
        outcome: 'correct',
        source: 'markup',
      })
    }

    const { joined } = await joinSplitQuestions(client(), worksheetId)

    expect(joined).toBe(0)
    expect(
      await db
        .select({ id: questions.id })
        .from(questions)
        .where(eq(questions.worksheetId, worksheetId)),
    ).toHaveLength(2)
  })
})
