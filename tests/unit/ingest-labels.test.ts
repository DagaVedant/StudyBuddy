import { describe, expect, it, vi } from 'vitest'

import type { ExtractedQuestion } from '@/lib/ai/types'
import { persistQuestions } from '@/lib/worker/ingest'

/**
 * A provider that skips the extraction schema (the mock does exactly this)
 * hands its rows straight to persistQuestions, so the label normalisation has
 * to live there rather than in each provider.
 */
function fakeDb(captured: { label: string; text: string }[]) {
  let inserted: unknown[] = []

  const insert = vi.fn((_table: unknown) => ({
    values: vi.fn(async (rows: { label?: string; text?: string }[] | object) => {
      const list = Array.isArray(rows) ? rows : [rows]

      if (list[0] && 'label' in (list[0] as object)) {
        for (const row of list as { label?: string; text?: string }[]) {
          captured.push({ label: String(row.label), text: String(row.text) })
        }
      } else {
        inserted = list
      }

      return undefined
    }),
    // One id per row, because the questions go in as a single batched insert
    // and the choices are keyed off the returned order.
    returning: vi.fn(async () => inserted.map((_, i) => ({ id: `question-${i + 1}` }))),
  }))

  // Only the shapes persistQuestions uses: a select of existing rows, the
  // single-row lookup of the page's text, and inserts that either return an id
  // (questions) or do not (choices).
  const empty = () => Object.assign(Promise.resolve([]), { limit: async () => [] })

  const fake: Record<string, unknown> = {
    select: () => ({
      from: () => ({ where: empty }),
    }),
    insert: (table: unknown) => {
      const handle = insert(table)
      return {
        values: (rows: unknown) => {
          const promise = handle.values(rows as never)
          return Object.assign(promise, { returning: handle.returning })
        },
      }
    },
    // persistQuestions batches its two writes into one transaction. The fake
    // just runs the body against itself.
    transaction: async (body: (tx: unknown) => Promise<unknown>) => body(fake),
  }

  return fake as never
}

const QUESTION = (
  choices: { label: string; text: string }[],
  over: Partial<ExtractedQuestion> = {},
): ExtractedQuestion => ({
  ordinal: 1,
  prompt_text: 'A rectangular garden measures 12 m by 8 m. What is its area?',
  question_type: 'multiple_choice',
  choices,
  bbox: null,
  has_figure: false,
  ...over,
})

describe('persistQuestions label handling', () => {
  it('reduces a label that arrived with its option stuck to it', async () => {
    const captured: { label: string; text: string }[] = []

    await persistQuestions(
      fakeDb(captured),
      { worksheetId: 'w1', userId: 'u1' },
      'page-1',
      [
        QUESTION([
          { label: 'A. 96', text: '96' },
          { label: 'B. 40', text: '40' },
          { label: 'C. 20', text: '20' },
          { label: 'D. 48', text: '48' },
        ]),
      ],
    )

    expect(captured.map((c) => c.label)).toEqual(['A', 'B', 'C', 'D'])
    expect(captured.map((c) => c.text)).toEqual(['96', '40', '20', '48'])
  })

  it('strips the punctuation a paper prints around a label', async () => {
    const captured: { label: string; text: string }[] = []

    await persistQuestions(
      fakeDb(captured),
      { worksheetId: 'w1', userId: 'u1' },
      'page-1',
      [
        QUESTION([
          { label: 'A.', text: '96' },
          { label: '(B)', text: '40' },
        ]),
      ],
    )

    expect(captured.map((c) => c.label)).toEqual(['A', 'B'])
  })

  /**
   * `topic_test13_20` stored an orphaned option block as its question 17 and
   * the real stem for 17 was never stored at all, so every count-based check
   * passed on a sheet with a garbage question in it. Ingest drops a row whose
   * whole prompt is a run of options, but only after the merge, and only
   * after the merge has made sure the surviving stem is the real one, or the
   * drop would take a good question's options down with the bad row's text.
   */
  it('keeps the real stem when an option block arrives under the same number', async () => {
    const captured: { label: string; text: string }[] = []

    const created = await persistQuestions(
      fakeDb(captured),
      { worksheetId: 'w1', userId: 'u1' },
      'page-1',
      [
        QUESTION([], {
          prompt_text: 'A. 1 hole   B. 4 holes   C. 2 holes same side   D. 2 holes opposite sides',
        }),
        QUESTION([
          { label: 'A', text: '1 hole' },
          { label: 'B', text: '4 holes' },
          { label: 'C', text: '2 holes same side' },
        ]),
      ],
    )

    expect(created).toBe(1)
    expect(captured.map((c) => c.label)).toEqual(['A', 'B', 'C'])
  })

  it('drops a row that is nothing but an option block', async () => {
    const captured: { label: string; text: string }[] = []

    const created = await persistQuestions(
      fakeDb(captured),
      { worksheetId: 'w1', userId: 'u1' },
      'page-1',
      [
        QUESTION([], {
          prompt_text: 'A. 1 hole   B. 4 holes   C. 2 holes same side   D. 2 holes opposite sides',
        }),
      ],
    )

    expect(created).toBe(0)
    expect(captured).toEqual([])
  })

  // The same orphan, minus whatever the page break took with it. Re-reading
  // topic_test8_15 produced this exact row and stored it as a second question
  // 14 beside the real one, because the check used to require the run to start
  // at A.
  it('drops an option block that lost its first options with the stem', async () => {
    const captured: { label: string; text: string }[] = []

    const created = await persistQuestions(
      fakeDb(captured),
      { worksheetId: 'w1', userId: 'u1' },
      'page-1',
      [QUESTION([], { prompt_text: 'B. 18   C. 144   D. 81' })],
    )

    expect(created).toBe(0)
    expect(captured).toEqual([])
  })

  it('leaves numeric labels alone, which a lead-in list needs', async () => {
    const captured: { label: string; text: string }[] = []

    await persistQuestions(
      fakeDb(captured),
      { worksheetId: 'w1', userId: 'u1' },
      'page-1',
      [
        QUESTION([
          { label: '1', text: 'The first sentence of the passage under discussion.' },
          { label: '2', text: 'The second sentence of the passage under discussion.' },
        ]),
      ],
    )

    expect(captured.map((c) => c.label)).toEqual(['1', '2'])
  })
})
