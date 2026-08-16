/**
 * `lib/questions/shape.ts`: what a question and its options are allowed to
 * look like once stored.
 */

import { describe, expect, it } from 'vitest'
import { normalizeChoiceLabel, normalizeOptionText } from '@/lib/questions/shape'
import { validateQuestion } from '@/lib/questions/validate'

describe('choice labels', () => {
describe('normalizeChoiceLabel', () => {
  it('leaves a bare label alone', () => {
    expect(normalizeChoiceLabel('A')).toBe('A')
    expect(normalizeChoiceLabel(' d ')).toBe('d')
  })

  it('strips the punctuation a paper prints around a label', () => {
    expect(normalizeChoiceLabel('(A)')).toBe('A')
    expect(normalizeChoiceLabel('B.')).toBe('B')
    expect(normalizeChoiceLabel('[C]')).toBe('C')
  })

  // Stored on eleven questions of edison_topic_test12_20: the option text came
  // through in the label field, so the review screen read "A. 60. 60" and the
  // answer key could not match C against "C. 53".
  it('takes the letter when the option text came with it', () => {
    expect(normalizeChoiceLabel('A. 60')).toBe('A')
    expect(normalizeChoiceLabel('C. 53')).toBe('C')
    expect(normalizeChoiceLabel('A. 75°F')).toBe('A')
    expect(normalizeChoiceLabel('(D) -4')).toBe('D')
  })

  it('keeps a numeric label, which a paper can mean literally', () => {
    expect(normalizeChoiceLabel('1')).toBe('1')
    expect(normalizeChoiceLabel('2.')).toBe('2')
  })

  it('falls back to the original when there is nothing to clean', () => {
    expect(normalizeChoiceLabel('...')).toBe('...')
  })
})
})

describe('option text', () => {
/** Options that differ only by sign or by where the punctuation falls. */
const REAL_PAIRS: [string, string][] = [
  ['-2', '2'],
  ['-3/4', '3/4'],
  ['4/3', '-4/3'],
  ['(6, -2)', '(6, 2)'],
  ['(6, -2)', '(-6, 2)'],
  ['(1, -6)', '(-1, 6)'],
  ['+5%', '-5%'],
  ['-4 cm/min', '4 cm/min'],
]

describe('normalizeOptionText', () => {
  it('keeps two options apart when only the sign differs', () => {
    for (const [left, right] of REAL_PAIRS) {
      expect(normalizeOptionText(left), `${left} vs ${right}`).not.toBe(
        normalizeOptionText(right),
      )
    }
  })

  it('still folds spacing and case, which do not change the answer', () => {
    expect(normalizeOptionText('3 / 4')).toBe(normalizeOptionText('3/4'))
    expect(normalizeOptionText('12 CM')).toBe(normalizeOptionText('12 cm'))
    expect(normalizeOptionText(' 40 ')).toBe(normalizeOptionText('40'))
  })

  it('reads the paper’s dashes as one dash', () => {
    // A minus sign, an en dash and a hyphen all print as a minus.
    expect(normalizeOptionText('−2')).toBe(normalizeOptionText('-2'))
    expect(normalizeOptionText('–2')).toBe(normalizeOptionText('-2'))
  })
})

const question = (choices: string[]) => ({
  promptText: 'What value of x satisfies 4x + 8 = 0?',
  questionType: 'multiple_choice',
  printedNumber: 1,
  choices: choices.map((text, index) => ({ label: 'ABCD'[index], text })),
})

describe('validateQuestion duplicate options', () => {
  // Every one of the 44 duplicate_choices flags on the stored worksheets was a
  // pair like this. None of them was a real duplicate, and each one sent a
  // page for a re-read that could not find anything wrong.
  it('does not call a sign change a duplicate', () => {
    const flags = validateQuestion(question(['-2', '2', '-4', '4']))
    expect(flags.map((flag) => flag.code)).not.toContain('duplicate_choices')
  })

  it('does not call two coordinates duplicates', () => {
    const flags = validateQuestion(question(['(6, -2)', '(-6, 2)', '(6, 2)', '(-6, -2)']))
    expect(flags.map((flag) => flag.code)).not.toContain('duplicate_choices')
  })

  it('still catches an option printed twice', () => {
    const flags = validateQuestion(question(['12', '15', '12', '20']))
    expect(flags.map((flag) => flag.code)).toContain('duplicate_choices')
  })

  it('still catches one printed twice with different spacing', () => {
    const flags = validateQuestion(question(['3/4', '1/2', '3 / 4', '2/3']))
    expect(flags.map((flag) => flag.code)).toContain('duplicate_choices')
  })
})

const stemOnly = (promptText: string) => ({
  promptText,
  questionType: 'multiple_choice',
  printedNumber: 1,
  choices: [
    { label: 'A', text: '1' },
    { label: 'B', text: '2' },
    { label: 'C', text: '3' },
    { label: 'D', text: '4' },
  ],
})

describe('validateQuestion nothing-asked', () => {
  // Both were stored on real papers, both carry a printed number, and both are
  // short enough to fall under three prose words while carrying no operator the
  // maths test recognises.
  it('does not condemn a short question that asks', () => {
    for (const stem of ['60 is what percent of 40?', 'Dot sequence: 1, 3, 5, 7,?']) {
      expect(
        validateQuestion(stemOnly(stem)).map((flag) => flag.code),
        stem,
      ).not.toContain('stem_is_not_a_question')
    }
  })

  // What the check is for: page furniture and figure labels, none of which ask
  // anything.
  it('still condemns a row that asks nothing', () => {
    for (const stem of ['CONTINUE ON TO THE NEXT PAGE', '(C)', 'C(3,y)nA(5,7) B(11,7)']) {
      expect(
        validateQuestion(stemOnly(stem)).map((flag) => flag.code),
        stem,
      ).toContain('stem_is_not_a_question')
    }
  })

  it('still allows an almost wordless calculation', () => {
    expect(validateQuestion(stemOnly('3.6 / 0.018 =')).map((f) => f.code)).not.toContain(
      'stem_is_not_a_question',
    )
  })
})
})
