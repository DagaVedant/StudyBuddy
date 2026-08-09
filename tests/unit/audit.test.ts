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

  // Overshooting the stated total used to read as a clean run: the audit only
  // ever looked for gaps, so a misread or double-counted number passed
  // silently while claiming the paper was fully covered.
  it('reports numbers past the total the student gave', () => {
    const result = auditExtraction(
      [
        { pageNumber: 1, printed: [1, 2, 3] },
        { pageNumber: 2, printed: [4, 5, 115] },
      ],
      5,
    )

    expect(result.extra).toEqual([115])
    expect(result.found).toBe(6)
    expect(result.expected).toBe(5)
  })

  it('reports several overshoots in order', () => {
    const result = auditExtraction(
      [{ pageNumber: 1, printed: [1, 2, 9, 7] }],
      3,
    )

    expect(result.extra).toEqual([7, 9])
  })

  it('has nothing to overshoot when no total was given', () => {
    const result = auditExtraction([{ pageNumber: 1, printed: [1, 2, 300] }])

    expect(result.extra).toEqual([])
    expect(result.expected).toBeNull()
  })

  it('does not count the exact total as an overshoot', () => {
    const result = auditExtraction([{ pageNumber: 1, printed: [1, 2, 3] }], 3)

    expect(result.extra).toEqual([])
    expect(result.missing).toEqual([])
  })

  /**
   * `test8_15` lost pages 2 and 3 entirely and the audit reported 100 % recall,
   * because the solutions page had supplied numbers 8 to 15. A sheet missing
   * more than half its questions passed the only check that would have
   * triggered a re-read. The numbering being complete is not evidence that the
   * pages were read.
   */
  it('re-reads a page that prints questions and returned none', () => {
    const result = auditExtraction(
      [
        { pageNumber: 1, printed: [1, 2, 3, 4, 5, 6, 7], expectsQuestions: true },
        { pageNumber: 2, printed: [], expectsQuestions: true },
        { pageNumber: 3, printed: [8, 9, 10], expectsQuestions: true },
      ],
      10,
    )

    expect(result.missing).toEqual([])
    expect(result.silent).toEqual([2])
    expect(result.retry).toEqual([{ pageNumber: 2, expect: [] }])
  })

  it('leaves a page alone that has no questions on it to lose', () => {
    const result = auditExtraction(
      [
        { pageNumber: 1, printed: [1, 2], expectsQuestions: true },
        // A cover page, an instructions page, an answer key.
        { pageNumber: 2, printed: [], expectsQuestions: false },
      ],
      2,
    )

    expect(result.silent).toEqual([])
    expect(result.retry).toEqual([])
  })

  // Blaming the last numbered page is right when the page after it did produce
  // something. When it produced nothing, it is the page that lost them.
  it('sends the missing numbers to the silent page rather than its neighbour', () => {
    const result = auditExtraction(
      [
        { pageNumber: 1, printed: [1, 2], expectsQuestions: true },
        { pageNumber: 2, printed: [], expectsQuestions: true },
      ],
      4,
    )

    expect(result.silent).toEqual([2])
    expect(result.retry).toEqual([{ pageNumber: 2, expect: [3, 4] }])
  })

  // What test8_15 needed: page 1 held 1-7, pages 2 and 3 came back empty, and
  // the numbers 8-15 the audit thought it had were the solutions page's.
  it('splits a run of missing numbers across every silent page between', () => {
    const result = auditExtraction(
      [
        { pageNumber: 1, printed: [1, 2, 3, 4, 5, 6, 7], expectsQuestions: true },
        { pageNumber: 2, printed: [], expectsQuestions: true },
        { pageNumber: 3, printed: [], expectsQuestions: true },
        { pageNumber: 4, printed: [], expectsQuestions: false },
      ],
      15,
    )

    expect(result.silent).toEqual([2, 3])
    expect(result.retry).toEqual([
      { pageNumber: 2, expect: [8, 9, 10, 11, 12, 13, 14, 15] },
      { pageNumber: 3, expect: [8, 9, 10, 11, 12, 13, 14, 15] },
    ])
  })

  it('says nothing about silent pages when the caller cannot tell', () => {
    const result = auditExtraction(
      [
        { pageNumber: 1, printed: [1, 2, 3] },
        { pageNumber: 2, printed: [] },
      ],
      3,
    )

    expect(result.silent).toEqual([])
    expect(result.retry).toEqual([])
  })
})
