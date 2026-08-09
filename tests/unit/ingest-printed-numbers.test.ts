import { describe, expect, it } from 'vitest'

import type { ExtractedQuestion } from '@/lib/ai/types'
import { persistQuestions } from '@/lib/worker/ingest'

/**
 * Page 2 of topic_test3_20. Read on its own by the audit, the model numbered
 * what it could see from 1, and ingest stored that over the real numbering.
 */
const PAGE_TEXT = `9. What value of x satisfies x/4 + 7 = 12?
A. 20
B. 48
10. What value of x satisfies (2x + 1)/3 = x - 1?
A. -2
B. 2
11. The sum of three consecutive even integers is 90. What is the largest of the three?
A. 30
B. 28`

/** Captures the question rows, and serves the page's text to the one lookup. */
function fakeDb(captured: { printedNumber: number | null; promptText: string }[], pageText: string) {
  const selectResult = (rows: unknown[]) =>
    Object.assign(Promise.resolve(rows), { limit: async () => rows })

  return {
    select: (columns?: Record<string, unknown>) => ({
      from: () => ({
        // The page lookup asks for ocrText and nothing else.
        where: () =>
          columns && 'ocrText' in columns
            ? selectResult([{ ocrText: pageText }])
            : selectResult([]),
      }),
    }),
    insert: () => ({
      values: (rows: unknown) => {
        if (!Array.isArray(rows)) {
          const row = rows as { printedNumber?: number | null; promptText?: string }
          if ('promptText' in row) {
            captured.push({
              printedNumber: row.printedNumber ?? null,
              promptText: String(row.promptText),
            })
          }
        }
        return Object.assign(Promise.resolve(undefined), {
          returning: async () => [{ id: `q-${captured.length}` }],
        })
      },
    }),
  } as never
}

const QUESTION = (ordinal: number, prompt_text: string): ExtractedQuestion => ({
  ordinal,
  prompt_text,
  question_type: 'multiple_choice',
  choices: [
    { label: 'A', text: '20' },
    { label: 'B', text: '48' },
  ],
  bbox: null,
  has_figure: false,
})

describe('persistQuestions printed numbers', () => {
  it('files a re-read page under the numbers the page prints', async () => {
    const captured: { printedNumber: number | null; promptText: string }[] = []

    // What the audit's re-read actually returns: the page's 9, 10 and 11
    // counted as 1, 2 and 3.
    await persistQuestions(
      fakeDb(captured, PAGE_TEXT),
      { worksheetId: 'w1', userId: 'u1' },
      'page-2',
      [
        QUESTION(1, 'What value of x satisfies x/4 + 7 = 12?'),
        QUESTION(2, 'What value of x satisfies (2x + 1)/3 = x - 1?'),
        QUESTION(
          3,
          'The sum of three consecutive even integers is 90. What is the largest of the three?',
        ),
      ],
    )

    expect(captured.map((row) => row.printedNumber)).toEqual([9, 10, 11])
  })

  it('keeps the model count when the page says nothing useful', async () => {
    const captured: { printedNumber: number | null; promptText: string }[] = []

    await persistQuestions(
      fakeDb(captured, ''),
      { worksheetId: 'w1', userId: 'u1' },
      'page-2',
      [QUESTION(4, 'A rectangular garden measures 12 m by 8 m. What is its area?')],
    )

    expect(captured.map((row) => row.printedNumber)).toEqual([4])
  })
})
