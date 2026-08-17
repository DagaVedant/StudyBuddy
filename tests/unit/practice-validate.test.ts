import { describe, expect, it } from 'vitest'

import type { GeneratedQuestion } from '@/lib/ai/types'
import {
  isUsable,
  practiceHash,
  siftPractice,
  validateGenerated,
} from '@/lib/practice/validate'

function question(overrides: Partial<GeneratedQuestion> = {}): GeneratedQuestion {
  return {
    prompt_text: 'A box holds 6 pencils. How many pencils are in 7 boxes?',
    choices: [
      { label: 'A', text: '42' },
      { label: 'B', text: '13' },
      { label: 'C', text: '36' },
      { label: 'D', text: '48' },
    ],
    correct_label: 'A',
    working: 'Multiply the boxes by the pencils in each: 6 x 7 = 42 pencils.',
    ...overrides,
  }
}

const codes = (flags: { code: string }[]) => flags.map((flag) => flag.code)

describe('a question that is fit to practise on', () => {
  it('raises nothing', () => {
    expect(validateGenerated(question())).toEqual([])
  })

  it('is usable', () => {
    expect(isUsable(validateGenerated(question()))).toBe(true)
  })
})

describe('the answer key has to be defensible', () => {
  it('rejects an answer that is not one of the options', () => {
    const flags = validateGenerated(question({ correct_label: 'E' }))

    expect(codes(flags)).toContain('no_correct_option')
    expect(isUsable(flags)).toBe(false)
  })

  it('rejects a second option that says the same thing as the answer', () => {
    const flags = validateGenerated(
      question({
        choices: [
          { label: 'A', text: '42' },
          { label: 'B', text: '42' },
          { label: 'C', text: '36' },
          { label: 'D', text: '48' },
        ],
      }),
    )

    expect(codes(flags)).toContain('answer_not_unique')
    expect(isUsable(flags)).toBe(false)
  })

  it('rejects fewer than four options', () => {
    const flags = validateGenerated(
      question({
        choices: [
          { label: 'A', text: '42' },
          { label: 'B', text: '13' },
          { label: 'C', text: '36' },
        ],
      }),
    )

    expect(codes(flags)).toContain('wrong_choice_count')
  })

  it('rejects labels that are not A to D', () => {
    const flags = validateGenerated(
      question({
        choices: [
          { label: 'A', text: '42' },
          { label: 'B', text: '13' },
          { label: 'D', text: '36' },
          { label: 'E', text: '48' },
        ],
        correct_label: 'A',
      }),
    )

    expect(codes(flags)).toContain('labels_not_abcd')
  })
})

describe('the options must not give the key away', () => {
  it('rejects an answer printed in the stem', () => {
    const flags = validateGenerated(
      question({
        prompt_text:
          'A box holds 6 pencils, so 7 boxes hold 42 pencils. How many pencils are in 7 boxes?',
      }),
    )

    expect(codes(flags)).toContain('answer_in_stem')
  })

  it('rejects the correct option being far the longest', () => {
    const flags = validateGenerated(
      question({
        choices: [
          {
            label: 'A',
            text: 'Forty-two, because each of the seven boxes contributes six pencils',
          },
          { label: 'B', text: 'Thirteen' },
          { label: 'C', text: 'Thirty-six' },
          { label: 'D', text: 'Forty-eight' },
        ],
      }),
    )

    expect(codes(flags)).toContain('answer_gives_itself_away')
  })

  it.each([
    'All of the above',
    'None of the above',
    'Both A and C',
  ])('rejects "%s" as an option', (text) => {
    const flags = validateGenerated(
      question({
        choices: [
          { label: 'A', text: '42' },
          { label: 'B', text: '13' },
          { label: 'C', text: '36' },
          { label: 'D', text },
        ],
      }),
    )

    expect(codes(flags)).toContain('option_about_the_options')
  })
})

describe('a question a student could not answer here', () => {
  it('rejects one that needs a figure', () => {
    const flags = validateGenerated(
      question({
        prompt_text: 'In the diagram above, what is the measure of angle ABC?',
      }),
    )

    expect(codes(flags)).toContain('needs_a_figure')
  })

  it('rejects LaTeX a student would read as markup', () => {
    const flags = validateGenerated(
      question({
        prompt_text: 'What is \\frac{1}{2} of 84?',
      }),
    )

    expect(codes(flags)).toContain('markup_leaked')
  })

  it('keeps a question about money, which is not LaTeX', () => {
    const flags = validateGenerated(
      question({
        prompt_text: 'A jacket costs $80. It is reduced by 15%. What is the new price?',
        choices: [
          { label: 'A', text: '$68' },
          { label: 'B', text: '$65' },
          { label: 'C', text: '$12' },
          { label: 'D', text: '$92' },
        ],
        correct_label: 'A',
        working: 'Take 15% of 80: 0.15 x 80 = 12. Subtract: 80 - 12 = 68 dollars.',
      }),
    )

    expect(codes(flags)).not.toContain('markup_leaked')
  })

  it('rejects one with no working to show afterwards', () => {
    const flags = validateGenerated(question({ working: 'It is A.' }))

    expect(codes(flags)).toContain('no_working')
  })
})

describe('a reply the model made up entirely', () => {
  it('survives a label built out of regular expression syntax', () => {
    const flags = validateGenerated(question({ correct_label: '(*' }))

    expect(codes(flags)).toContain('no_correct_option')
  })

  it('survives having no options at all', () => {
    const flags = validateGenerated(question({ choices: [] }))

    expect(codes(flags)).toContain('wrong_choice_count')
    expect(isUsable(flags)).toBe(false)
  })
})

describe('duplicates', () => {
  it('rejects the same stem twice in one batch', () => {
    const { kept, rejected } = siftPractice([question(), question()])

    expect(kept).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(codes(rejected[0].flags)).toContain('duplicate_of_batch')
  })

  it('rejects a question the student already owns', () => {
    const owned = practiceHash(question())
    const { kept, rejected } = siftPractice([question()], [owned])

    expect(kept).toEqual([])
    expect(codes(rejected[0].flags)).toContain('duplicate_of_library')
  })

  it('keeps two questions that differ', () => {
    const other = question({
      prompt_text: 'A tray holds 9 eggs. How many eggs are in 4 trays?',
      choices: [
        { label: 'A', text: '36' },
        { label: 'B', text: '13' },
        { label: 'C', text: '27' },
        { label: 'D', text: '45' },
      ],
      working: 'Multiply the trays by the eggs in each: 9 x 4 = 36 eggs.',
    })

    expect(siftPractice([question(), other]).kept).toHaveLength(2)
  })
})

describe('siftPractice', () => {
  it('keeps the good ones and reports the rest', () => {
    const bad = question({ correct_label: 'E' })
    const { kept, rejected } = siftPractice([bad, question()])

    expect(kept).toHaveLength(1)
    expect(rejected).toHaveLength(1)
  })

  it('returns nothing kept when everything is broken', () => {
    const { kept, rejected } = siftPractice([
      question({ correct_label: 'E' }),
      question({ working: '' }),
    ])

    expect(kept).toEqual([])
    expect(rejected).toHaveLength(2)
  })
})
