import { asc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { answerChoices, questions, worksheetPages } from '@/lib/db/schema'
import { recoverCarriedChoices } from '@/lib/worker/carried-choices-apply'

import { asDb, createTestDb, type TestDb } from '../helpers/db'
import { makeUser, makeWorksheet } from '../helpers/factories'

let db: TestDb
let close: () => Promise<void>

beforeAll(async () => {
  const created = await createTestDb()
  db = created.db
  close = created.close
})

afterAll(async () => { await close() })

const client = () => asDb(db)

const OPTIONS = [
  { label: 'A', text: '20' },
  { label: 'B', text: '21' },
  { label: 'C', text: '23' },
  { label: 'D', text: '24' },
  { label: 'E', text: '26' },
]

/** AMC8 2024 page 4: question 14's options, printed above question 15. */
const PAGE_TEXT_CARRYING = `AoPS Community 2024 AMC 8 -
(A) 28 (B) 29 (C) 30 (D) 31 (E) 32
15 Let the letters F , L , Y , B , U , G represent different digits here.`

const PAGE_TEXT_PLAIN = `AoPS Community 2024 AMC 8 -
15 Let the letters F , L , Y , B , U , G represent different digits here.`

interface Q {
  page: number
  ordinal: number
  printed: number | null
  top: number
  prompt: string
  type?: 'multiple_choice' | 'free_response' | 'grid_in'
  choices?: { label: string; text: string }[]
}

const WHOLE = (n: number, page: number, top: number): Q => ({
  page,
  ordinal: n,
  printed: n,
  top,
  prompt: `Whole question number ${n} that asks something of the student here.`,
  choices: OPTIONS,
})

/** The stem stranded at the foot of page 3 with its options on page 4. */
const STRANDED: Q = {
  page: 3,
  ordinal: 14,
  printed: 14,
  top: 1069,
  type: 'free_response',
  prompt:
    'The one-way routes connecting towns A, M, C, X, Y, and Z are shown in the figure below. ' +
    'Traveling along these routes, what is the shortest distance from A to Z in kilometers?',
  choices: [],
}

async function seed(spec: Q[], pageText: Record<number, string>): Promise<string> {
  const userId = await makeUser(db)
  const worksheetId = await makeWorksheet(db, userId)

  const pageIds = new Map<number, string>()
  for (const pageNumber of Object.keys(pageText).map(Number).sort((a, b) => a - b)) {
    const [row] = await db
      .insert(worksheetPages)
      .values({
        worksheetId,
        pageNumber,
        imageKey: `k${pageNumber}`,
        ocrText: pageText[pageNumber],
      })
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
        questionType: s.type ?? 'multiple_choice',
        bbox: [140, s.top, 1170, s.top + 60],
        contentHash: `hash-${s.ordinal}`,
      })
      .returning({ id: questions.id })

    for (const choice of s.choices ?? []) {
      await db
        .insert(answerChoices)
        .values({ questionId: row.id, label: choice.label, text: choice.text, isCorrect: false })
    }
  }

  return worksheetId
}

async function read(worksheetId: string) {
  const rows = await db
    .select({
      id: questions.id,
      printed: questions.printedNumber,
      type: questions.questionType,
      contentHash: questions.contentHash,
    })
    .from(questions)
    .where(eq(questions.worksheetId, worksheetId))
    .orderBy(asc(questions.ordinal))

  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      choices: await db
        .select({ label: answerChoices.label, text: answerChoices.text })
        .from(answerChoices)
        .where(eq(answerChoices.questionId, row.id)),
    })),
  )
}

/** Three whole questions so the sheet has a settled option count of five. */
const SHEET: Q[] = [
  WHOLE(12, 3, 639),
  WHOLE(13, 3, 903),
  STRANDED,
  WHOLE(15, 4, 300),
  WHOLE(16, 4, 700),
]

const TEXT = { 3: 'page three text', 4: PAGE_TEXT_CARRYING }

describe('recoverCarriedChoices', () => {
  it('gives the stranded question the options printed on the next page', async () => {
    const id = await seed(SHEET, TEXT)

    expect(await recoverCarriedChoices(client(), id)).toEqual({ recovered: 1 })

    const fourteen = (await read(id)).find((row) => row.printed === 14)!
    expect(fourteen.choices.map((c) => `${c.label}${c.text}`)).toEqual([
      'A28',
      'B29',
      'C30',
      'D31',
      'E32',
    ])
  })

  it('makes it a multiple-choice question, which is the only way the options show', async () => {
    const id = await seed(SHEET, TEXT)
    await recoverCarriedChoices(client(), id)

    expect((await read(id)).find((row) => row.printed === 14)!.type).toBe('multiple_choice')
  })

  it('rehashes the question it changed', async () => {
    const id = await seed(SHEET, TEXT)
    await recoverCarriedChoices(client(), id)

    const fourteen = (await read(id)).find((row) => row.printed === 14)!
    expect(fourteen.contentHash).not.toBe('hash-14')
  })

  it('adds nothing on a second run', async () => {
    const id = await seed(SHEET, TEXT)

    await recoverCarriedChoices(client(), id)
    expect(await recoverCarriedChoices(client(), id)).toEqual({ recovered: 0 })
  })

  // Everything below is a case where the options would go to the wrong place.

  it('leaves a page that carries nothing', async () => {
    const id = await seed(SHEET, { 3: 'page three text', 4: PAGE_TEXT_PLAIN })

    expect(await recoverCarriedChoices(client(), id)).toEqual({ recovered: 0 })
  })

  it('never overwrites a question that already has its options', async () => {
    const id = await seed(
      SHEET.map((s) => (s.printed === 14 ? { ...s, choices: OPTIONS } : s)),
      TEXT,
    )

    expect(await recoverCarriedChoices(client(), id)).toEqual({ recovered: 0 })
    expect((await read(id)).find((row) => row.printed === 14)!.choices).toHaveLength(5)
  })

  it('leaves a grid-in, which is answer-free by design', async () => {
    const id = await seed(
      SHEET.map((s) => (s.printed === 14 ? { ...s, type: 'grid_in' as const } : s)),
      TEXT,
    )

    expect(await recoverCarriedChoices(client(), id)).toEqual({ recovered: 0 })
  })

  it('leaves page furniture caught at the foot of a page', async () => {
    const id = await seed(
      SHEET.map((s) => (s.printed === 14 ? { ...s, prompt: '(C)' } : s)),
      TEXT,
    )

    expect(await recoverCarriedChoices(client(), id)).toEqual({ recovered: 0 })
  })

  it('refuses when the options are really the next question’s own', async () => {
    // Question 15 already holds exactly this block, so the parse read its
    // answers rather than anything carried over.
    const id = await seed(
      SHEET.map((s) =>
        s.printed === 15
          ? {
              ...s,
              choices: [
                { label: 'A', text: '28' },
                { label: 'B', text: '29' },
                { label: 'C', text: '30' },
                { label: 'D', text: '31' },
                { label: 'E', text: '32' },
              ],
            }
          : s,
      ),
      TEXT,
    )

    expect(await recoverCarriedChoices(client(), id)).toEqual({ recovered: 0 })
  })

  it('handles a worksheet of one page', async () => {
    const id = await seed([WHOLE(1, 1, 200)], { 1: PAGE_TEXT_CARRYING })

    expect(await recoverCarriedChoices(client(), id)).toEqual({ recovered: 0 })
  })

  it('handles a worksheet with no questions', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    expect(await recoverCarriedChoices(client(), worksheetId)).toEqual({ recovered: 0 })
  })
})
