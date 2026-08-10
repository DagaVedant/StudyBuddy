import { describe, expect, it } from 'vitest'

import { exportFilename, toBlooketCsv, type ExportQuestion } from '@/lib/blooket/csv'

function question(spec: Partial<ExportQuestion> = {}): ExportQuestion {
  return {
    id: 'q1',
    promptText: 'What is the value of x?',
    questionType: 'multiple_choice',
    correctAnswer: null,
    choices: [],
    ...spec,
  }
}

function mc(labels: string[], correct: string): ExportQuestion['choices'] {
  return labels.map((label) => ({
    label,
    text: `Option ${label}`,
    isCorrect: label === correct,
  }))
}

/** The lines Blooket actually reads: it drops the first two by position. */
function dataLines(csv: string): string[] {
  return csv.trimEnd().split('\r\n').slice(2)
}

function fields(line: string): string[] {
  return line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((field) => {
    const match = /^"([\s\S]*)"$/.exec(field)
    return match ? match[1].replace(/""/g, '"') : field
  })
}

describe('toBlooketCsv', () => {
  it('writes every line ten fields wide, including the two Blooket discards', () => {
    // The parser runs with relax_column_count off and silently retries with a
    // semicolon delimiter when the comma parse throws. A ragged file therefore
    // imports zero questions and reports nothing, which is the single worst
    // failure this format has.
    const { csv } = toBlooketCsv([
      question({ id: 'a', choices: mc(['A', 'B', 'C', 'D'], 'C') }),
      question({ id: 'b', promptText: 'Name the capital.', correctAnswer: 'Paris' }),
    ])

    const lines = csv.trimEnd().split('\r\n')

    expect(lines).toHaveLength(4)
    for (const line of lines) {
      expect(fields(line)).toHaveLength(10)
    }
  })

  it('numbers the correct answer by position, never by label', () => {
    const { csv } = toBlooketCsv([question({ choices: mc(['A', 'B', 'C', 'D'], 'C') })])

    expect(fields(dataLines(csv)[0])[7]).toBe('3')
  })

  it('lists several correct answers comma separated in one cell', () => {
    const choices = mc(['A', 'B', 'C', 'D'], 'A')
    choices[3].isCorrect = true

    const { csv } = toBlooketCsv([question({ choices })])

    expect(fields(dataLines(csv)[0])[7]).toBe('1,4')
  })

  it('renumbers the answers after trimming a five-option question to four', () => {
    // Blooket has nowhere to put a fifth option. Dropping from the end would
    // have dropped this question's answer, and a silently wrong key is worse
    // than a missing question.
    const choices = mc(['A', 'B', 'C', 'D', 'E'], 'E')
    const { csv } = toBlooketCsv([question({ choices })])
    const row = fields(dataLines(csv)[0])

    expect(row.slice(2, 6)).toEqual(['Option A', 'Option B', 'Option C', 'Option E'])
    expect(row[7]).toBe('4')
  })

  it('reads a key stored on the question when no choice row is flagged', () => {
    const choices = mc(['A', 'B', 'C', 'D'], 'none')
    const { csv } = toBlooketCsv([question({ choices, correctAnswer: 'B' })])

    expect(fields(dataLines(csv)[0])[7]).toBe('2')
  })

  it('sends a free response question through as a typed answer', () => {
    const { csv } = toBlooketCsv([
      question({
        questionType: 'free_response',
        promptText: 'Name the capital of France.',
        correctAnswer: 'Paris',
      }),
    ])

    const row = fields(dataLines(csv)[0])

    expect(row.slice(2, 6)).toEqual(['Paris', '', '', ''])
    expect(row[7]).toBe('1')
    expect(row[9]).toBe('typing')
  })

  it('rebuilds the two options of a true or false question', () => {
    // Typed answers are matched exactly, so asking this one by typing would
    // score "T" and "true" as wrong.
    const { csv } = toBlooketCsv([
      question({
        questionType: 'true_false',
        promptText: 'Every square is a rectangle.',
        correctAnswer: 'True',
      }),
    ])

    const row = fields(dataLines(csv)[0])

    expect(row.slice(2, 6)).toEqual(['True', 'False', '', ''])
    expect(row[7]).toBe('1')
    expect(row[9]).toBe('')
  })

  it('skips a question nobody knows the answer to, and says so', () => {
    const { csv, included, skipped } = toBlooketCsv([
      question({ id: 'keep', choices: mc(['A', 'B', 'C', 'D'], 'A') }),
      question({ id: 'drop', choices: mc(['A', 'B', 'C', 'D'], 'none') }),
    ])

    expect(included).toBe(1)
    expect(skipped).toEqual([{ questionId: 'drop', reason: 'no-answer' }])
    expect(dataLines(csv)).toHaveLength(1)
  })

  it('numbers the rows it kept, not the questions it was given', () => {
    const { csv } = toBlooketCsv([
      question({ id: 'drop', choices: mc(['A', 'B'], 'none') }),
      question({ id: 'keep', choices: mc(['A', 'B', 'C', 'D'], 'A') }),
    ])

    expect(fields(dataLines(csv)[0])[0]).toBe('1')
  })

  it('flattens the line breaks a print column left in the prompt', () => {
    const { csv } = toBlooketCsv([
      question({
        promptText: 'The product of the two num-\nbers rolled\nis a multiple of 6.',
        choices: mc(['A', 'B', 'C', 'D'], 'A'),
      }),
    ])

    expect(fields(dataLines(csv)[0])[1]).toBe(
      'The product of the two numbers rolled is a multiple of 6.',
    )
  })

  it('quotes a prompt containing a comma or a quotation mark', () => {
    const { csv } = toBlooketCsv([
      question({
        promptText: 'If x = 2, what is "y"?',
        choices: mc(['A', 'B', 'C', 'D'], 'A'),
      }),
    ])

    const line = dataLines(csv)[0]

    expect(line).toContain('"If x = 2, what is ""y""?"')
    expect(fields(line)[1]).toBe('If x = 2, what is "y"?')
    expect(fields(line)).toHaveLength(10)
  })

  it('drops a lone surviving choice rather than importing an unloseable question', () => {
    const { csv, skipped } = toBlooketCsv([
      question({
        id: 'lonely',
        choices: [{ label: 'A', text: 'Only option', isCorrect: true }],
      }),
    ])

    expect(dataLines(csv)).toHaveLength(0)
    expect(skipped).toEqual([{ questionId: 'lonely', reason: 'no-answer' }])
  })

  it('leads with a byte order mark so Excel reads the maths symbols', () => {
    const { csv } = toBlooketCsv([question({ choices: mc(['A', 'B'], 'A') })])

    expect(csv.startsWith('﻿')).toBe(true)
  })
})

describe('exportFilename', () => {
  it('names the whole-account export by date alone', () => {
    expect(exportFilename('2026-08-10')).toBe('studybuddy-missed-2026-08-10.csv')
  })

  it('works the worksheet title into the name', () => {
    expect(exportFilename('2026-08-10', 'Algebra Unit 3')).toBe(
      'studybuddy-missed-algebra-unit-3-2026-08-10.csv',
    )
  })

  it('strips the characters that would break the Content-Disposition header', () => {
    // The name goes inside a quoted `filename="..."`. A title carrying a quote
    // would close that quoting early and truncate the header, so titles are
    // reduced to a safe alphabet rather than escaped.
    const name = exportFilename('2026-08-10', 'Unit 3 "Review", part 2\\')

    expect(name).toBe('studybuddy-missed-unit-3-review-part-2-2026-08-10.csv')
    expect(name).not.toMatch(/["\\,;]/)
  })

  it('falls back to the plain name when a title reduces to nothing', () => {
    // Any ASCII at all survives and is used, digits included, so this needs a
    // title with none: `数学 第3回` slugs to `3`, which is poor but harmless.
    expect(exportFilename('2026-08-10', '数学')).toBe('studybuddy-missed-2026-08-10.csv')
  })

  it('never trails a hyphen after cutting a long title short', () => {
    const name = exportFilename('2026-08-10', `${'a'.repeat(59)} tail`)

    expect(name).toBe(`studybuddy-missed-${'a'.repeat(59)}-2026-08-10.csv`)
  })
})
