import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { ExtractedQuestion } from '@/lib/ai/types'
import type { Db } from '@/lib/dashboard/queries'
import { questions, worksheetPages } from '@/lib/db/schema'
import { persistQuestions } from '@/lib/worker/ingest'

import { createTestDb, type TestDb } from '../helpers/db'
import { makeUser, makeWorksheet } from '../helpers/factories'

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

function question(
  promptText: string,
  choices: { label: string; text: string }[] = [],
): ExtractedQuestion {
  return {
    ordinal: 1,
    prompt_text: promptText,
    question_type: choices.length ? 'multiple_choice' : 'free_response',
    choices: choices.map((choice) => ({ ...choice, isCorrect: false })),
    bbox: null,
    has_figure: false,
    confidence: 0.9,
  } as ExtractedQuestion
}

async function makePage(worksheetId: string, pageNumber = 1): Promise<string> {
  const [row] = await db
    .insert(worksheetPages)
    .values({ worksheetId, pageNumber, imageKey: `k-${pageNumber}` })
    .returning({ id: worksheetPages.id })
  return row.id
}

async function setup() {
  const userId = await makeUser(db)
  const worksheetId = await makeWorksheet(db, userId)
  return { job: { userId, worksheetId }, pageId: await makePage(worksheetId) }
}

describe('persistQuestions', () => {
  /*
   * A local vision model can stutter. One real SHSAT page emitted the same
   * reading question four times in a single reply, which inflated that page
   * from 3 questions to 6.
   */
  it('drops a question the model repeated in one reply', async () => {
    const { job, pageId } = await setup()

    const repeated = question('Which quotation best supports the idea?', [
      { label: 'A', text: 'First' },
      { label: 'B', text: 'Second' },
    ])

    const created = await persistQuestions(db as Db, job, pageId, [
      repeated,
      repeated,
      repeated,
      repeated,
    ])

    expect(created).toBe(1)

    const rows = await db
      .select()
      .from(questions)
      .where(eq(questions.worksheetId, job.worksheetId))

    expect(rows).toHaveLength(1)
  })

  it('drops a repeat that arrives on a later page', async () => {
    const { job, pageId } = await setup()
    const second = await makePage(job.worksheetId, 2)

    const shared = question('What is the theme of the passage?')

    expect(await persistQuestions(db as Db, job, pageId, [shared])).toBe(1)
    expect(await persistQuestions(db as Db, job, second, [shared])).toBe(0)
  })

  // Dedup keys on prompt *and* options together. Reading sections reuse stems
  // like "Which quotation best supports..." across different questions, and
  // those are genuinely different questions.
  it('keeps a shared stem when the options differ', async () => {
    const { job, pageId } = await setup()

    const created = await persistQuestions(db as Db, job, pageId, [
      question('Which quotation best supports the idea?', [
        { label: 'A', text: 'The hunters rode up.' },
        { label: 'B', text: 'They paraded around.' },
      ]),
      question('Which quotation best supports the idea?', [
        { label: 'A', text: 'Gentle arms lifted her.' },
        { label: 'B', text: 'The women brought food.' },
      ]),
    ])

    expect(created).toBe(2)
  })

  it('numbers questions continuously across pages', async () => {
    const { job, pageId } = await setup()
    const second = await makePage(job.worksheetId, 2)

    await persistQuestions(db as Db, job, pageId, [question('One'), question('Two')])
    await persistQuestions(db as Db, job, second, [question('Three')])

    const rows = await db
      .select({ ordinal: questions.ordinal, promptText: questions.promptText })
      .from(questions)
      .where(eq(questions.worksheetId, job.worksheetId))

    expect(rows.map((row) => row.ordinal).sort((a, b) => a - b)).toEqual([1, 2, 3])
  })

  it('stores nothing for a page with no questions', async () => {
    const { job, pageId } = await setup()

    expect(await persistQuestions(db as Db, job, pageId, [])).toBe(0)
  })
})
