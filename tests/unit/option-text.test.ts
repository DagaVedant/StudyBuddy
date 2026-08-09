import { describe, expect, it } from 'vitest'

import { normalizeOptionText } from '@/lib/questions/shape'
import { validateQuestion } from '@/lib/questions/validate'

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
