import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { attempts, questions, reviewCards } from '@/lib/db/schema'
import { mergeDuplicateQuestions } from '@/lib/worker/duplicates-apply'
import { joinSplitQuestions } from '@/lib/worker/join-splits'
import { planPageReplacement } from '@/lib/worker/review'
import { partitionByDeletability } from '@/lib/worker/safe-delete'

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

/**
 * The fourth way a question gets deleted, which had no guard at all.
 *
 * The three passes above go through `deletableQuestionIds`. The audit re-read
 * does not: it posts `page_review`, and the job route deleted every doubted row
 * outright. So a worksheet the student had already marked up could lose an
 * answered question, its attempt and its review card, and the job would report
 * the row as replaced exactly as it does on a clean run.
 */
describe('partitionByDeletability', () => {
  it('holds back the rows somebody has answered and passes the rest', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const [answered, untouched] = await seedDuplicatePair(userId, worksheetId)

    await db.insert(attempts).values({
      userId,
      questionId: answered,
      outcome: 'wrong',
      source: 'markup',
    })

    const rows = [
      { id: answered, printedNumber: 1 },
      { id: untouched, printedNumber: 2 },
    ]

    const { removable, held } = await partitionByDeletability(client(), rows)

    // The whole row comes back, not just the id: the re-read needs the printed
    // number to pair the row with its replacement.
    expect(held).toEqual([{ id: answered, printedNumber: 1 }])
    expect(removable).toEqual([{ id: untouched, printedNumber: 2 }])
  })

  it('holds back a row carrying a review card', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const [scheduled] = await seedDuplicatePair(userId, worksheetId)

    await db.insert(reviewCards).values({ userId, questionId: scheduled, dueAt: new Date() })

    const { removable, held } = await partitionByDeletability(client(), [{ id: scheduled }])

    expect(held).toHaveLength(1)
    expect(removable).toHaveLength(0)
  })

  it('passes everything through on a worksheet nobody has reached', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const pair = await seedDuplicatePair(userId, worksheetId)

    const { removable, held } = await partitionByDeletability(
      client(),
      pair.map((id) => ({ id })),
    )

    expect(removable).toHaveLength(2)
    expect(held).toHaveLength(0)
  })

  it('does not query on an empty list', async () => {
    expect(await partitionByDeletability(client(), [])).toEqual({
      removable: [],
      held: [],
    })
  })
})

/**
 * The composition, which is where the fix actually lives.
 *
 * Holding the row back is only half of it. `planPageReplacement` pairs each
 * doubted row with the freshly read question that carries the same printed
 * number, so a held row whose replacement still went through would leave the
 * page holding both the student's answered question and its replacement: two
 * rows where the paper printed one. Filtering before the plan is built is what
 * drops the replacement with it.
 */
describe('the audit re-read on a worksheet that has been marked up', () => {
  const pageText = '1. What is the area?  A. 96  B. 20\n2. And the perimeter?  A. 40  B. 96'

  const fresh = [
    { ordinal: 1, prompt_text: 'What is the area?' },
    { ordinal: 2, prompt_text: 'And the perimeter?' },
  ]

  it('neither deletes the answered row nor stores its replacement', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const [answered, untouched] = await seedDuplicatePair(userId, worksheetId)

    await db.insert(attempts).values({
      userId,
      questionId: answered,
      outcome: 'wrong',
      source: 'markup',
    })

    const doubted = [
      { id: answered, printedNumber: 1 },
      { id: untouched, printedNumber: 2 },
    ]

    const { removable } = await partitionByDeletability(client(), doubted)
    const plan = planPageReplacement(pageText, fresh, removable)

    expect(plan.replace.map((row) => row.id)).toEqual([untouched])
    expect(plan.replacements).toEqual([fresh[1]])
  })

  it('replaces both when nobody has answered either', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    const [first, second] = await seedDuplicatePair(userId, worksheetId)

    const doubted = [
      { id: first, printedNumber: 1 },
      { id: second, printedNumber: 2 },
    ]

    const { removable } = await partitionByDeletability(client(), doubted)
    const plan = planPageReplacement(pageText, fresh, removable)

    expect(plan.replace).toHaveLength(2)
    expect(plan.replacements).toHaveLength(2)
  })
})

/**
 * Both merge rules run off one snapshot and the plans are applied one by one,
 * so two plans could name the same printed number and the second would
 * overwrite the first, leaving two rows both claiming it. That is the exact
 * state the audit then tries to repair by deleting one of them.
 *
 * The collision is hard to construct deliberately, which is why it survived so
 * long: the number-duplicate rule refuses any group that is not exactly a pair,
 * so the obvious four-row seed folds nothing at all. What is testable, and what
 * actually matters, is the invariant on the way out. No number may be held
 * twice once the pass has run.
 */
describe('printed numbers after a merge', () => {
  it('never leaves a number held by two rows', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    // A foldable pair on number 1, and a real neighbour on 2 for the survivor
    // to collide with if the number were handed out carelessly.
    await seedDuplicatePair(userId, worksheetId)

    await db.insert(questions).values({
      userId,
      worksheetId,
      ordinal: 3,
      printedNumber: 2,
      promptText: 'A different question entirely, about probability.',
      questionType: 'multiple_choice',
    })

    const { merged } = await mergeDuplicateQuestions(client(), worksheetId)
    expect(merged).toBe(1)

    const left = await db
      .select({ printedNumber: questions.printedNumber })
      .from(questions)
      .where(eq(questions.worksheetId, worksheetId))

    const numbers = left
      .map((row) => row.printedNumber)
      .filter((n): n is number => n !== null)

    expect(numbers).toHaveLength(2)
    expect(new Set(numbers).size).toBe(numbers.length)
  })
})
