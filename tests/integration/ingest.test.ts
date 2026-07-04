import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { ExtractedQuestion } from '@/lib/ai/types'
import type { Db } from '@/lib/dashboard/queries'
import { answerChoices, questions, worksheetPages } from '@/lib/db/schema'
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

  /*
   * The model can split one multiple-choice question into one entry per
   * option — same stem, a different slice of the choices each time. Hash dedup
   * cannot see that, because prompt+choices really do differ.
   */
  it('folds a question the model split across its own options', async () => {
    const { job, pageId } = await setup()

    const stem = 'Which quotation best supports the idea that The People feel a connection?'

    const created = await persistQuestions(db as Db, job, pageId, [
      question(stem, [{ label: 'A', text: 'The hunters rode up.' }]),
      question(stem, [{ label: 'B', text: 'They paraded around.' }]),
      question(stem, [{ label: 'C', text: 'Gentle arms lifted her.' }]),
      question(stem, [{ label: 'D', text: 'The women brought food.' }]),
    ])

    expect(created).toBe(1)

    const [row] = await db
      .select({ id: questions.id })
      .from(questions)
      .where(eq(questions.worksheetId, job.worksheetId))

    // The scattered options belong to that one question.
    const choices = await db
      .select()
      .from(answerChoices)
      .where(eq(answerChoices.questionId, row.id))

    expect(choices).toHaveLength(4)
    expect(choices.map((c) => c.label).sort()).toEqual(['A', 'B', 'C', 'D'])
  })

  it('drops a repeat that arrives on a later page', async () => {
    const { job, pageId } = await setup()
    const second = await makePage(job.worksheetId, 2)

    const shared = question('What is the theme of the passage?')

    expect(await persistQuestions(db as Db, job, pageId, [shared])).toBe(1)
    expect(await persistQuestions(db as Db, job, second, [shared])).toBe(0)
  })

  /*
   * Reading sections reuse the opening of a stem across several questions, so
   * merging must compare the whole prompt. In the real material the idea being
   * asked about is always named inside the stem, which is what keeps these
   * apart — an earlier version of this test asserted that two *character-
   * identical* stems stayed separate, a case the source material never
   * actually produces.
   */
  it('keeps questions whose stems share an opening but name different ideas', async () => {
    const { job, pageId } = await setup()

    const created = await persistQuestions(db as Db, job, pageId, [
      question(
        'Which quotation best supports the idea that The People feel a connection?',
        [{ label: 'A', text: 'The hunters rode up.' }],
      ),
      question(
        'Which quotation best supports the idea that the journey was difficult?',
        [{ label: 'A', text: 'Gentle arms lifted her.' }],
      ),
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
