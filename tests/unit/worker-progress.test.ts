import { describe, expect, it } from 'vitest'

import {
  CLASSIFYING_AT,
  READING_SHARE,
  VERIFYING_AT,
  phaseFor,
  readingProgress,
} from '@/lib/worker/progress'

describe('readingProgress', () => {
  it('starts near zero on the first page of many', () => {
    expect(readingProgress(1, 100)).toBeCloseTo(0.008)
  })

  it('stops short of full when the last page is read', () => {
    expect(readingProgress(75, 75)).toBe(READING_SHARE)
    expect(readingProgress(75, 75)).toBeLessThan(1)
  })

  it('never divides by zero', () => {
    expect(readingProgress(1, 0)).toBe(0)
  })
})

describe('phaseFor', () => {
  it('calls the page-reading stretch reading', () => {
    expect(phaseFor(0)).toBe('reading')
    expect(phaseFor(0.5)).toBe('reading')
    expect(phaseFor(READING_SHARE - 0.01)).toBe('reading')
  })

  it('switches to verifying exactly where reading tops out', () => {
    expect(phaseFor(VERIFYING_AT)).toBe('verifying')
    expect(phaseFor(0.9)).toBe('verifying')
  })

  it('switches to classifying at its own threshold', () => {
    expect(phaseFor(CLASSIFYING_AT)).toBe('classifying')
    expect(phaseFor(1)).toBe('classifying')
  })

  it('leaves no gap between the phases', () => {
    for (let p = 0; p <= 1.0001; p += 0.01) {
      expect(['reading', 'verifying', 'classifying']).toContain(phaseFor(p))
    }
  })
})
