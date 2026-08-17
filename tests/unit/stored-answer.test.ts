import { describe, expect, it } from 'vitest'

import { storedAnswer } from '@/lib/worker/solutions'

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

  it('matches an answer given as the option text', () => {
    expect(storedAnswer('12', [{ label: 'A', text: '4' }, { label: 'D', text: '12' }])).toBe('D')
  })

  it('is not case sensitive about option text', () => {
    expect(storedAnswer('  TWELVE ', [{ label: 'C', text: 'Twelve' }])).toBe('C')
  })

  it('answers in the case the paper used', () => {
    expect(storedAnswer('b', [{ label: 'B', text: '6' }])).toBe('B')
    expect(storedAnswer('B', [{ label: 'b', text: '6' }])).toBe('b')
  })

  it('refuses an answer that matches no option', () => {
    expect(storedAnswer('7', CHOICES)).toBeNull()
    expect(storedAnswer('Z', CHOICES)).toBeNull()
  })

  it('refuses an empty answer', () => {
    expect(storedAnswer('', CHOICES)).toBeNull()
    expect(storedAnswer('   ', CHOICES)).toBeNull()
  })

  it('keeps the value for a question with no options', () => {
    expect(storedAnswer('37.5', [])).toBe('37.5')
    expect(storedAnswer('  x = 4 ', [])).toBe('x = 4')
  })

  it('bounds a free-response answer rather than storing an essay', () => {
    expect(storedAnswer('x'.repeat(500), [])).toHaveLength(200)
  })
})
