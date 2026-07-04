import { describe, expect, it } from 'vitest'

import {
  countInRange,
  describePageRange,
  pageInRange,
  parsePageRange,
} from '@/lib/upload/page-range'

describe('parsePageRange', () => {
  // Both boxes empty is the default and must stay the zero-effort path.
  it('treats both boxes empty as every page', () => {
    const result = parsePageRange('', '')
    expect(result).toEqual({ ok: true, range: null })
  })

  it('ignores surrounding whitespace', () => {
    const result = parsePageRange('  1 ', ' 59 ')
    expect(result).toEqual({ ok: true, range: { from: 1, to: 59 } })
  })

  it('defaults the start to page 1 when only an end is given', () => {
    const result = parsePageRange('', '59')
    expect(result).toEqual({ ok: true, range: { from: 1, to: 59 } })
  })

  it('runs to the last page when only a start is given', () => {
    const result = parsePageRange('60', '')
    expect(result).toEqual({ ok: true, range: { from: 60, to: null } })
  })

  it('accepts a single page', () => {
    const result = parsePageRange('7', '7')
    expect(result).toEqual({ ok: true, range: { from: 7, to: 7 } })
  })

  it.each([
    ['0', '', /1 or more/],
    ['-3', '', /1 or more/],
    ['1.5', '', /whole number/],
    ['abc', '', /whole number/],
    ['', 'xyz', /whole number/],
  ])('rejects %o / %o', (from, to, message) => {
    const result = parsePageRange(from, to)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(message)
  })

  it('rejects an end before the start', () => {
    const result = parsePageRange('59', '10')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/before page 59/)
  })
})

describe('pageInRange', () => {
  it('keeps every page when there is no range', () => {
    expect(pageInRange(1, null)).toBe(true)
    expect(pageInRange(9999, null)).toBe(true)
  })

  it('includes both endpoints', () => {
    const range = { from: 10, to: 12 }
    expect([9, 10, 11, 12, 13].map((n) => pageInRange(n, range))).toEqual([
      false,
      true,
      true,
      true,
      false,
    ])
  })

  it('has no upper bound when the end is open', () => {
    const range = { from: 60, to: null }
    expect(pageInRange(59, range)).toBe(false)
    expect(pageInRange(112, range)).toBe(true)
  })
})

describe('countInRange', () => {
  it('counts the whole document without a range', () => {
    expect(countInRange(112, null)).toBe(112)
  })

  // The real case: a 112-page SHSAT form whose test section ends at page 59.
  it('counts a bounded range inclusively', () => {
    expect(countInRange(112, { from: 1, to: 59 })).toBe(59)
    expect(countInRange(112, { from: 60, to: 112 })).toBe(53)
  })

  it('stops at the last real page when the range runs past the end', () => {
    expect(countInRange(20, { from: 1, to: 500 })).toBe(20)
    expect(countInRange(20, { from: 10, to: null })).toBe(11)
  })

  it('is zero when the range starts past the end', () => {
    expect(countInRange(20, { from: 40, to: 50 })).toBe(0)
  })
})

describe('describePageRange', () => {
  it('reads naturally in an error message', () => {
    expect(describePageRange(null)).toBe('every page')
    expect(describePageRange({ from: 1, to: 59 })).toBe('pages 1–59')
    expect(describePageRange({ from: 7, to: 7 })).toBe('page 7')
    expect(describePageRange({ from: 60, to: null })).toBe('page 60 onwards')
  })
})
