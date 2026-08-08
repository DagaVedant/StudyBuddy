import { describe, expect, it, vi } from 'vitest'

import type { ExtractedQuestion } from '@/lib/ai/types'
import { persistQuestions } from '@/lib/worker/ingest'

/**
 * A provider that skips the extraction schema — the mock does exactly this —
 * hands its rows straight to persistQuestions, so the label normalisation has
 * to live there rather than in each provider.
 */
function fakeDb(captured: { label: string; text: string }[]) {
  const insert = vi.fn((_table: unknown) => ({
    values: vi.fn(async (rows: { label?: string; text?: string }[] | object) => {
      if (Array.isArray(rows) && rows[0] && 'label' in rows[0]) {
        for (const row of rows) {
          captured.push({ label: String(row.label), text: String(row.text) })
        }
      }
      return undefined
    }),
    returning: vi.fn(async () => [{ id: 'question-1' }]),
  }))

  // Only the two shapes persistQuestions uses: a select of existing rows, and
  // inserts that either return an id (questions) or do not (choices).
  return {
    select: () => ({
      from: () => ({ where: async () => [] }),
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
  } as never
}

const QUESTION = (choices: { label: string; text: string }[]): ExtractedQuestion => ({
  ordinal: 1,
  prompt_text: 'A rectangular garden measures 12 m by 8 m. What is its area?',
  question_type: 'multiple_choice',
  choices,
  bbox: null,
  has_figure: false,
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
