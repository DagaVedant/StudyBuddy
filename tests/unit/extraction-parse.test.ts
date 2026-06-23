import { describe, expect, it } from 'vitest'

import { parseExtraction } from '@/lib/ai/types'

function reply(...prompts: string[]) {
  return {
    questions: prompts.map((prompt_text, index) => ({
      ordinal: index + 1,
      prompt_text,
      question_type: 'multiple_choice',
      choices: [
        { label: 'A', text: 'first' },
        { label: 'B', text: 'second' },
      ],
      bbox: null,
      has_figure: false,
      confidence: 0.9,
    })),
  }
}

describe('parseExtraction', () => {
  /*
   * Documents bundle a test with its answer explanations, and each explanation
   * restates the question it discusses before analysing the options. The vision
   * model reads that restatement as a question. Three prompt phrasings were
   * tested against real explanation pages — naming the pattern, leading with
   * it, describing the page layout — and every one still returned them, so it
   * is filtered here instead.
   */
  it('drops an explanation restating the question it is about', () => {
    const result = parseExtraction(
      reply(
        'The question asks which revision of sentence 2 uses the most precise language.',
        'The question asks for the identification of the sentence that has an error.',
        'Question asks which sentence should follow sentence 4.',
      ),
    )

    expect(result.questions).toHaveLength(0)
    expect(result.rejected).toBe(3)
  })

  // A question never opens by describing itself in the third person, which is
  // what keeps the filter from touching real ones.
  it('keeps questions that merely mention the word question', () => {
    const result = parseExtraction(
      reply(
        'Which question would best guide further research on this topic?',
        'The questions in every mind were about the approaching riders.',
        'What question does paragraph 4 raise about the tunnel?',
      ),
    )

    expect(result.questions).toHaveLength(3)
    expect(result.rejected).toBe(0)
  })

  it('keeps real questions from a page that also had a restatement', () => {
    const result = parseExtraction(
      reply(
        'The question asks which revision uses the most precise language.',
        'Which sentence should be added after sentence 5?',
      ),
    )

    expect(result.questions).toHaveLength(1)
    expect(result.questions[0].prompt_text).toMatch(/^Which sentence/)
    expect(result.rejected).toBe(1)
  })

  it('separates a malformed entry from a filtered one in the count', () => {
    const result = parseExtraction({
      questions: [
        { nonsense: true },
        ...reply('The question asks about tone.', 'What is 2 + 2?').questions,
      ],
    })

    expect(result.questions).toHaveLength(1)
    expect(result.rejected).toBe(2)
  })

  it('returns nothing for a reply that is not an extraction', () => {
    expect(parseExtraction({ nope: 1 }).questions).toHaveLength(0)
    expect(parseExtraction(null).questions).toHaveLength(0)
  })
})
