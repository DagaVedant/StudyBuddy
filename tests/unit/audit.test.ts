import { describe, expect, it } from 'vitest'

import { auditExtraction } from '@/lib/worker/audit'

describe('auditExtraction', () => {
  it('reports nothing when the run is complete', () => {
    const result = auditExtraction(
      [
        { pageNumber: 1, printed: [1, 2, 3] },
        { pageNumber: 2, printed: [4, 5] },
      ],
      5,
    )

    expect(result.missing).toEqual([])
    expect(result.retry).toEqual([])
    expect(result.found).toBe(5)
  })

  it('finds a gap without being told the total', () => {
    const result = auditExtraction([
      { pageNumber: 1, printed: [1, 2, 3] },
      { pageNumber: 2, printed: [6, 7] },
    ])

    expect(result.missing).toEqual([4, 5])
    expect(result.expected).toBeNull()
  })

  it('retries the pages on both sides of a gap', () => {
    const result = auditExtraction([
      { pageNumber: 8, printed: [45, 46] },
      { pageNumber: 9, printed: [48, 49] },
    ])

    expect(result.missing).toEqual([47])
    expect(result.retry).toEqual([
      { pageNumber: 8, expect: [47] },
      { pageNumber: 9, expect: [47] },
    ])
  })

  it('blames one page when its own range brackets the gap', () => {
    const result = auditExtraction([
      { pageNumber: 1, printed: [1, 2] },
      { pageNumber: 2, printed: [3, 6] },
      { pageNumber: 3, printed: [7] },
    ])

    expect(result.missing).toEqual([4, 5])
    expect(result.retry).toEqual([{ pageNumber: 2, expect: [4, 5] }])
  })

  it('needs the total to see questions missing off the end', () => {
    const pages = [
      { pageNumber: 1, printed: [1, 2, 3] },
      { pageNumber: 2, printed: [4, 5] },
    ]

    expect(auditExtraction(pages).missing).toEqual([])
    expect(auditExtraction(pages, 7).missing).toEqual([6, 7])
  })

  it('sends trailing misses to the last numbered page', () => {
    const result = auditExtraction(
      [
        { pageNumber: 1, printed: [1, 2] },
        { pageNumber: 2, printed: [3, 4] },
      ],
      6,
    )

    expect(result.retry).toEqual([{ pageNumber: 2, expect: [5, 6] }])
  })

  it('audits a mid-document slice from where its numbering starts', () => {
    const result = auditExtraction(
      [
        { pageNumber: 30, printed: [47, 48] },
        { pageNumber: 31, printed: [50] },
      ],
      114,
    )

    expect(result.missing).toEqual([49])
  })

  it('retries the empty pages when the first pass found nothing at all', () => {
    const result = auditExtraction(
      [
        { pageNumber: 1, printed: [] },
        { pageNumber: 2, printed: [] },
      ],
      3,
    )

    expect(result.missing).toEqual([1, 2, 3])
    expect(result.retry.map((r) => r.pageNumber)).toEqual([1, 2])
  })

  it('ignores unnumbered questions rather than treating them as number 0', () => {
    const result = auditExtraction([
      { pageNumber: 1, printed: [0, 0, 0] },
      { pageNumber: 2, printed: [1, 2] },
    ])

    expect(result.found).toBe(2)
    expect(result.missing).toEqual([])
  })

  it('stays quiet on a worksheet with no numbering', () => {
    const result = auditExtraction([
      { pageNumber: 1, printed: [] },
      { pageNumber: 2, printed: [] },
    ])

    expect(result.missing).toEqual([])
    expect(result.retry).toEqual([])
  })
})
