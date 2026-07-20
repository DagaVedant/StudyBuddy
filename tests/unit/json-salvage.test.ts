import { describe, expect, it } from 'vitest'

import { parseModelJson, salvageTruncatedJson } from '@/lib/ai/json'
import { parseExtraction } from '@/lib/ai/types'

function question(n: number, text = `Question ${n}`) {
  return {
    ordinal: n,
    prompt_text: text,
    question_type: 'multiple_choice',
    choices: [{ label: 'A', text: 'first' }],
    bbox: null,
    has_figure: false,
  }
}

describe('salvageTruncatedJson', () => {
  it('keeps the complete entries when the reply stops mid-object', () => {
    const full = JSON.stringify({ questions: [question(1), question(2), question(3)] })
    const cut = full.slice(0, full.indexOf('Question 3') + 4)

    const salvaged = salvageTruncatedJson(cut) as { questions: unknown[] }
    expect(salvaged.questions).toHaveLength(2)
  })

  it('is not fooled by braces inside question text', () => {
    const tricky = JSON.stringify({
      questions: [
        question(1, 'Evaluate f(x) for the set {1, 2, 3} where }] appears'),
        question(2),
      ],
    })
    const cut = `${tricky.slice(0, tricky.length - 6)}`

    const salvaged = salvageTruncatedJson(cut) as { questions: { prompt_text: string }[] }
    expect(salvaged.questions.length).toBeGreaterThanOrEqual(1)
    expect(salvaged.questions[0].prompt_text).toContain('{1, 2, 3}')
  })

  it('handles an escaped quote before the truncation point', () => {
    const full = JSON.stringify({
      questions: [question(1, 'She said \\"hello\\" loudly'), question(2)],
    })
    const cut = full.slice(0, full.length - 10)

    expect(salvageTruncatedJson(cut)).not.toBeNull()
  })

  it('returns null when not even one entry completed', () => {
    expect(salvageTruncatedJson('{"questions": [{"ordinal": 1, "prompt')).toBeNull()
    expect(salvageTruncatedJson('not json at all')).toBeNull()
  })
})

describe('parseModelJson', () => {
  it('parses valid JSON without flagging truncation', () => {
    const result = parseModelJson(JSON.stringify({ questions: [question(1)] }))
    expect(result.truncated).toBe(false)
  })

  it('flags a salvaged reply so callers can log it', () => {
    const full = JSON.stringify({ questions: [question(1), question(2)] })
    const result = parseModelJson(full.slice(0, full.length - 8))
    expect(result.truncated).toBe(true)
  })

  it('throws only when nothing at all can be recovered', () => {
    expect(() => parseModelJson('{"questions": [{"ordi')).toThrow(/salvaged/i)
  })

  it('salvaged output still satisfies the extraction schema', () => {
    const full = JSON.stringify({
      questions: [question(1), question(2), question(3)],
    })
    const { value } = parseModelJson(full.slice(0, full.indexOf('Question 3')))
    const { questions } = parseExtraction(value)

    expect(questions).toHaveLength(2)
    expect(questions[0].prompt_text).toBe('Question 1')
  })
})
