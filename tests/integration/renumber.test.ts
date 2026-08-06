import { asc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Db } from '@/lib/dashboard/queries'
import { questions, worksheetPages } from '@/lib/db/schema'
import { renumberQuestions } from '@/lib/worker/renumber'

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

async function seed(
  spec: { page: number; printed: number | null; ordinal: number }[],
): Promise<string> {
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
    await db.insert(questions).values({
      userId,
      worksheetId,
      pageId: pageIds.get(s.page)!,
      ordinal: s.ordinal,
      printedNumber: s.printed,
      promptText: `p${s.page} n${s.printed}`,
      questionType: 'multiple_choice',
    })
  }
  return worksheetId
}

const read = async (worksheetId: string) =>
  db
    .select({ ordinal: questions.ordinal, printed: questions.printedNumber })
    .from(questions)
    .where(eq(questions.worksheetId, worksheetId))
    .orderBy(asc(questions.ordinal))

describe('renumberQuestions', () => {
  // The exact shape parallel page reads produced: page 4 finished before page
  // 3 and took the lower numbers.
  it('puts questions back in page order', async () => {
    const id = await seed([
      { page: 4, printed: 2, ordinal: 1 },
      { page: 4, printed: 3, ordinal: 2 },
      { page: 3, printed: 1, ordinal: 4 },
    ])

    await renumberQuestions(client(), id)

    expect(await read(id)).toEqual([
      { ordinal: 1, printed: 1 },
      { ordinal: 2, printed: 2 },
      { ordinal: 3, printed: 3 },
    ])
  })

  // Two pages saved at once both read the same max ordinal and both took it.
  it('breaks a tie where two rows share an ordinal', async () => {
    const id = await seed([
      { page: 8, printed: 5, ordinal: 7 },
      { page: 9, printed: 9, ordinal: 7 },
    ])

    await renumberQuestions(client(), id)

    expect(await read(id)).toEqual([
      { ordinal: 1, printed: 5 },
      { ordinal: 2, printed: 9 },
    ])
  })

  it('closes gaps left behind by a merge', async () => {
    const id = await seed([
      { page: 1, printed: 1, ordinal: 3 },
      { page: 1, printed: 2, ordinal: 8 },
      { page: 2, printed: 3, ordinal: 14 },
    ])

    await renumberQuestions(client(), id)
    expect((await read(id)).map((r) => r.ordinal)).toEqual([1, 2, 3])
  })

  it('keeps unnumbered questions in the order they were read', async () => {
    const id = await seed([
      { page: 1, printed: null, ordinal: 2 },
      { page: 1, printed: null, ordinal: 1 },
      { page: 1, printed: 1, ordinal: 5 },
    ])

    await renumberQuestions(client(), id)

    // The printed one leads its page; the unnumbered pair hold their read order.
    expect(await read(id)).toEqual([
      { ordinal: 1, printed: 1 },
      { ordinal: 2, printed: null },
      { ordinal: 3, printed: null },
    ])
  })

  it('reports nothing to do on a worksheet already in order', async () => {
    const id = await seed([
      { page: 1, printed: 1, ordinal: 1 },
      { page: 1, printed: 2, ordinal: 2 },
    ])

    expect(await renumberQuestions(client(), id)).toEqual({ renumbered: 0 })
  })

  it('handles a worksheet with no questions', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    expect(await renumberQuestions(client(), worksheetId)).toEqual({ renumbered: 0 })
  })
})
