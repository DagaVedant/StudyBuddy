import { describe, expect, it } from 'vitest'

import { sortWithinPage } from '@/lib/questions/page-text'

const q = (
  name: string,
  printedNumber: number | null,
  top: number | null,
  position: number,
) => ({ name, printedNumber, top, position })

const order = (page: ReturnType<typeof q>[]) => sortWithinPage(page).map((row) => row.name)

describe('sortWithinPage', () => {
  // AMC8 2024 page 1. The bboxes overlap and put question 4 below question 5,
  // which the numbers printed on the paper settle.
  it('trusts the number printed on the paper over the geometry', () => {
    expect(
      order([
        q('four', 4, 1428, 4),
        q('five', 5, 1379, 5),
        q('one', 1, 479, 1),
      ]),
    ).toEqual(['one', 'four', 'five'])
  })

  // AMC8 2024 page 3. The orphaned options have no number, so the numbers
  // cannot order the page and the layout has to.
  it('falls back to the layout when a question has no number', () => {
    expect(
      order([
        q('twelve', 12, 639, 12),
        q('orphan', null, 246, 15),
        q('thirteen', 13, 904, 13),
      ]),
    ).toEqual(['orphan', 'twelve', 'thirteen'])
  })

  it('falls back to arrival order when the layout is incomplete too', () => {
    expect(
      order([
        q('second', null, null, 2),
        q('first', null, 246, 1),
        q('third', 3, null, 3),
      ]),
    ).toEqual(['first', 'second', 'third'])
  })

  it('breaks a tie by arrival rather than leaving it to chance', () => {
    expect(order([q('late', 7, 100, 9), q('early', 7, 100, 2)])).toEqual(['early', 'late'])
  })

  it('leaves the caller its own array', () => {
    const page = [q('b', 2, 200, 2), q('a', 1, 100, 1)]
    sortWithinPage(page)

    expect(page.map((row) => row.name)).toEqual(['b', 'a'])
  })

  it('handles an empty page', () => {
    expect(sortWithinPage([])).toEqual([])
  })
})
