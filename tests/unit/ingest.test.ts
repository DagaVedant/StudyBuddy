import { describe, expect, it, vi } from 'vitest'
import type { ExtractedQuestion } from '@/lib/ai/types'
import { persistQuestions } from '@/lib/worker/ingest'

describe('choice labels', () => {
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
    returning: vi.fn(async () => inserted.map((_, i) => ({ id: `question-${i + 1}` }))),
  }))

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
})

describe('printed numbers', () => {
const PAGE_TEXT = `9. What value of x satisfies x/4 + 7 = 12?
A. 20
B. 48
10. What value of x satisfies (2x + 1)/3 = x - 1?
A. -2
B. 2
11. The sum of three consecutive even integers is 90. What is the largest of the three?
A. 30
B. 28`

function fakeDb(captured: { printedNumber: number | null; promptText: string }[], pageText: string) {
  const selectResult = (rows: unknown[]) =>
    Object.assign(Promise.resolve(rows), { limit: async () => rows })

  const fake: Record<string, unknown> = {
    select: (columns?: Record<string, unknown>) => ({
      from: () => ({
        where: () =>
          columns && 'ocrText' in columns
            ? selectResult([{ ocrText: pageText }])
            : selectResult([]),
      }),
    }),
    insert: () => ({
      values: (rows: unknown) => {
        const list = Array.isArray(rows) ? rows : [rows]
        const ids: { id: string }[] = []

        for (const entry of list) {
          const row = entry as { printedNumber?: number | null; promptText?: string }
          if ('promptText' in row) {
            captured.push({
              printedNumber: row.printedNumber ?? null,
              promptText: String(row.promptText),
            })
            ids.push({ id: `q-${captured.length}` })
          }
        }

        return Object.assign(Promise.resolve(undefined), {
          returning: async () => ids,
        })
      },
    }),
    transaction: async (body: (tx: unknown) => Promise<unknown>) => body(fake),
  }

  return fake as never
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
})
