import { describe, expect, it } from 'vitest'

import { normalizeChoiceLabel } from '@/lib/questions/shape'

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
