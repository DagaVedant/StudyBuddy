import { describe, expect, it } from 'vitest'

import { inferPrintedNumbers, type NumberedQuestion } from '@/lib/questions/infer-numbers'

let seq = 0
function q(
  pageNumber: number | null,
  printedNumber: number | null,
  id = `q${(seq += 1)}`,
): NumberedQuestion {
  return { id, pageNumber, position: seq, printedNumber }
}

describe('inferPrintedNumbers', () => {
  // Form B, page 5. Question 4 was extracted and arrived with no number.
  it('fills a blank sitting in a gap of one', () => {
    const fixes = inferPrintedNumbers(
      [q(4, 3), q(5, null, 'blank'), q(8, 5)],
      114,
    )

    expect(fixes).toEqual([{ id: 'blank', from: null, to: 4, reason: 'filled-blank' }])
  })

  // Form A, page 58. Question 113 came back labelled 1, which already existed
  // earlier, and 114 came back blank.
  it('corrects a stray number and fills the blank beside it', () => {
    const fixes = inferPrintedNumbers(
      [q(3, 1), q(57, 112), q(58, 1, 'stray'), q(58, null, 'blank')],
      114,
    )

    expect(fixes).toEqual([
      { id: 'stray', from: 1, to: 113, reason: 'corrected-stray' },
      { id: 'blank', from: null, to: 114, reason: 'filled-blank' },
    ])
  })

  it('fills a run of blanks in order', () => {
    const fixes = inferPrintedNumbers(
      [q(1, 10), q(2, null, 'a'), q(2, null, 'b'), q(3, 13)],
      20,
    )

    expect(fixes.map((f) => [f.id, f.to])).toEqual([
      ['a', 11],
      ['b', 12],
    ])
  })

  // The whole point. A plausible lie is worse than a visible blank.
  it('refuses when more numbers are free than there are questions', () => {
    expect(
      inferPrintedNumbers([q(1, 10), q(2, null, 'a'), q(5, 20)], 20),
    ).toEqual([])
  })

  it('refuses when more questions are blank than there are numbers', () => {
    expect(
      inferPrintedNumbers(
        [q(1, 10), q(2, null, 'a'), q(2, null, 'b'), q(2, null, 'c'), q(3, 12)],
        20,
      ),
    ).toEqual([])
  })

  it('leaves a correctly numbered paper completely alone', () => {
    expect(inferPrintedNumbers([q(1, 1), q(1, 2), q(2, 3)], 3)).toEqual([])
  })

  it('fills a blank at the very end, where there is no anchor after it', () => {
    const fixes = inferPrintedNumbers([q(1, 1), q(2, 2), q(3, null, 'last')], 3)
    expect(fixes).toEqual([{ id: 'last', from: null, to: 3, reason: 'filled-blank' }])
  })

  it('fills a blank at the very start, where there is no anchor before it', () => {
    const fixes = inferPrintedNumbers([q(1, null, 'first'), q(2, 2), q(3, 3)], 3)
    expect(fixes).toEqual([{ id: 'first', from: null, to: 1, reason: 'filled-blank' }])
  })

  it('does nothing when it has no trusted numbers to reason from', () => {
    expect(inferPrintedNumbers([q(1, null), q(2, null)], 5)).toEqual([])
  })

  it('handles an empty worksheet', () => {
    expect(inferPrintedNumbers([], 10)).toEqual([])
  })

  // Without a stated total it can still close interior gaps, but it must not
  // invent questions past the highest number it actually saw.
  it('works without an expected total', () => {
    const fixes = inferPrintedNumbers([q(1, 1), q(2, null, 'a'), q(3, 3)], null)
    expect(fixes).toEqual([{ id: 'a', from: null, to: 2, reason: 'filled-blank' }])
  })

  it('does not renumber a duplicate that is in the right place', () => {
    // Two rows genuinely claiming 5 with nothing missing around them: this is
    // a duplicate to merge, not a numbering fault to repair.
    expect(inferPrintedNumbers([q(1, 4), q(2, 5), q(2, 5), q(3, 6)], 6)).toEqual([])
  })
})
