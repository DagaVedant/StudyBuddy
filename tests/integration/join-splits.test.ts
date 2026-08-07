import { asc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Db } from '@/lib/dashboard/queries'
import { answerChoices, questions, worksheetPages } from '@/lib/db/schema'
import { joinSplitQuestions } from '@/lib/worker/join-splits'

import { createTestDb, type TestDb } from '../helpers/db'
import { makeUser, makeWorksheet } from '../helpers/factories'

let db: TestDb
let close: () => Promise<void>

beforeAll(async () => {
  const created = await createTestDb()
  db = created.db
  close = created.close
})

afterAll(async () => { await close() })

const client = () => db as unknown as Db

const OPTIONS = [
  { label: 'A', text: '8' },
  { label: 'B', text: '9' },
  { label: 'C', text: '10' },
  { label: 'D', text: '11' },
  { label: 'E', text: '12' },
]

/** Filler so the sheet has a settled option count of five to compare against. */
const FILLER = (n: number) => ({
  page: 1,
  ordinal: n,
  printed: n,
  top: n * 100,
  prompt: `Whole question number ${n} that asks something of the student here.`,
  choices: OPTIONS,
})

interface Spec {
  page: number
  ordinal: number
  printed: number | null
  top: number | null
  prompt: string
  choices: { label: string; text: string }[]
}

async function seed(spec: Spec[]): Promise<string> {
  const userId = await makeUser(db)
  const worksheetId = await makeWorksheet(db, userId)

  const pageIds = new Map<number, string>()
  for (const pageNumber of [...new Set(spec.map((s) => s.page))]) {
    const [row] = await db
      .insert(worksheetPages)
      .values({ worksheetId, pageNumber, imageKey: `k${pageNumber}` })
      .returning({ id: worksheetPages.id })
    pageIds.set(pageNumber, row.id)
  }

  for (const s of spec) {
    const [row] = await db
      .insert(questions)
      .values({
        userId,
        worksheetId,
        pageId: pageIds.get(s.page)!,
        ordinal: s.ordinal,
        printedNumber: s.printed,
        promptText: s.prompt,
        questionType: 'multiple_choice',
        bbox: s.top === null ? null : [140, s.top, 1170, s.top + 60],
        contentHash: `hash-${s.ordinal}`,
      })
      .returning({ id: questions.id })

    if (s.choices.length > 0) {
      await db.insert(answerChoices).values(
        s.choices.map((choice) => ({
          questionId: row.id,
          label: choice.label,
          text: choice.text,
          isCorrect: false,
        })),
      )
    }
  }

  return worksheetId
}

/** The AMC8 2024 shape: question 11 runs from the foot of page 2 onto page 3. */
const SPLIT: Spec[] = [
  FILLER(1),
  FILLER(2),
  FILLER(3),
  {
    page: 2,
    ordinal: 11,
    printed: 11,
    top: 1165,
    prompt:
      'The coordinates of △ ABC are A (5, 7), B (11, 7), C (3, y ), with y > 7. ' +
      'The area of △ ABC is 12. What is the value of y?',
    choices: [],
  },
  {
    // Written last, by a re-read, but printed at the very top of page 3.
    page: 3,
    ordinal: 15,
    printed: null,
    top: 246,
    prompt: 'C(3,y)nA(5,7) B(11,7)',
    choices: OPTIONS,
  },
  {
    page: 3,
    ordinal: 12,
    printed: 12,
    top: 639,
    prompt: 'Rohan keeps a total of 90 guppies in 4 fish tanks. How many are in the 4th?',
    choices: OPTIONS,
  },
]

async function read(worksheetId: string) {
  const rows = await db
    .select({
      id: questions.id,
      ordinal: questions.ordinal,
      printed: questions.printedNumber,
      prompt: questions.promptText,
      contentHash: questions.contentHash,
    })
    .from(questions)
    .where(eq(questions.worksheetId, worksheetId))
    .orderBy(asc(questions.ordinal))

  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      choices: (
        await db
          .select({ label: answerChoices.label })
          .from(answerChoices)
          .where(eq(answerChoices.questionId, row.id))
      ).length,
    })),
  )
}

describe('joinSplitQuestions', () => {
  it('folds the orphaned options back into the stem they belong to', async () => {
    const id = await seed(SPLIT)

    expect(await joinSplitQuestions(client(), id)).toEqual({ joined: 1 })

    const rows = await read(id)
    expect(rows).toHaveLength(5)

    const eleven = rows.find((row) => row.printed === 11)!
    expect(eleven.prompt).toContain('What is the value of y?')
    expect(eleven.choices).toBe(5)

    // The half that only ever held options is gone, and nothing else moved.
    expect(rows.some((row) => row.prompt.startsWith('C(3,y)'))).toBe(false)
    expect(rows.find((row) => row.printed === 12)!.choices).toBe(5)
  })

  it('rehashes the survivor, so a later re-read cannot store it twice', async () => {
    const id = await seed(SPLIT)
    await joinSplitQuestions(client(), id)

    const eleven = (await read(id)).find((row) => row.printed === 11)!

    expect(eleven.contentHash).not.toBe('hash-11')
    expect(eleven.contentHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('finds nothing left to join on a second run', async () => {
    const id = await seed(SPLIT)

    await joinSplitQuestions(client(), id)
    expect(await joinSplitQuestions(client(), id)).toEqual({ joined: 0 })
  })

  it('leaves a worksheet whose questions all came out whole', async () => {
    const id = await seed([FILLER(1), FILLER(2), { ...FILLER(3), page: 2 }])

    expect(await joinSplitQuestions(client(), id)).toEqual({ joined: 0 })
    expect(await read(id)).toHaveLength(3)
  })

  it('leaves a stem whose options were lost rather than moved', async () => {
    // Nothing on page 3 is an orphan, so there is nothing to join. The stem
    // stays as it is for the student to fix; it is not deleted, and page 3's
    // real question does not have its options taken away.
    const id = await seed(SPLIT.filter((s) => s.prompt !== 'C(3,y)nA(5,7) B(11,7)'))

    expect(await joinSplitQuestions(client(), id)).toEqual({ joined: 0 })
    expect(await read(id)).toHaveLength(5)
  })

  it('handles a worksheet with no questions', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    expect(await joinSplitQuestions(client(), worksheetId)).toEqual({ joined: 0 })
  })
})
