import { describe, expect, it } from 'vitest'

import { storedAnswer } from '@/lib/worker/solutions'

/**
 * Turning what a model said into what the app stores.
 *
 * This decides what a student is marked against, so the interesting cases are
 * the ones where refusing beats guessing. On a paper where every option reads
 * "4", "6", "9", "12", an answer of "6" is ambiguous between naming the label
 * and naming the value, and guessing wrong marks somebody down on a question
 * they got right.
 */

const CHOICES = [
  { label: 'A', text: '4' },
  { label: 'B', text: '6' },
  { label: 'C', text: '9' },
  { label: 'D', text: '12' },
]

describe('storedAnswer', () => {
  it('keeps a bare label', () => {
    expect(storedAnswer('B', CHOICES)).toBe('B')
  })

  it.each([
    ['lowercase', 'b'],
    ['with a bracket', 'B)'],
    ['with a full stop', 'B.'],
    ['surrounded by space', '  B  '],
    ['the whole option', 'B) 6'],
  ])('normalises %s to the label', (_case, answer) => {
    expect(storedAnswer(answer, CHOICES)).toBe('B')
  })

  /**
   * A model that answered with the option's text rather than its label is right
   * about the question and wrong about the format, which is worth recovering.
   */
  it('matches an answer given as the option text', () => {
    expect(storedAnswer('12', [{ label: 'A', text: '4' }, { label: 'D', text: '12' }])).toBe('D')
  })

  it('is not case sensitive about option text', () => {
    expect(storedAnswer('  TWELVE ', [{ label: 'C', text: 'Twelve' }])).toBe('C')
  })

  /**
   * Returned with the stored label's own case, not the model's. Extraction
   * keeps whatever the paper printed, and markup compares against that, so a
   * lowercase answer to an uppercase paper has to come back uppercase.
   */
  it('answers in the case the paper used', () => {
    expect(storedAnswer('b', [{ label: 'B', text: '6' }])).toBe('B')
    expect(storedAnswer('B', [{ label: 'b', text: '6' }])).toBe('b')
  })

  /**
   * The refusal that matters. "6" is the text of option B here, so it resolves;
   * "7" is neither a label nor any option's text, and storing it would mark
   * every student wrong on this question.
   */
  it('refuses an answer that matches no option', () => {
    expect(storedAnswer('7', CHOICES)).toBeNull()
    expect(storedAnswer('Z', CHOICES)).toBeNull()
  })

  it('refuses an empty answer', () => {
    expect(storedAnswer('', CHOICES)).toBeNull()
    expect(storedAnswer('   ', CHOICES)).toBeNull()
  })

  /** A written-in question has no options to match against, so the value is it. */
  it('keeps the value for a question with no options', () => {
    expect(storedAnswer('37.5', [])).toBe('37.5')
    expect(storedAnswer('  x = 4 ', [])).toBe('x = 4')
  })

  it('bounds a free-response answer rather than storing an essay', () => {
    expect(storedAnswer('x'.repeat(500), [])).toHaveLength(200)
  })
})
