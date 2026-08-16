import { describe, expect, it } from 'vitest'

import { printedNumbersFor } from '@/lib/questions/numbering'

// Page 2 of topic_test3_20, which prints 9 to 13. Re-read on its own, the
// model returned these numbered from 1 and ingest stored that, landing them on
// top of page 1's real 1-7.
const PAGE = `B. 20
C. 15
D. 24
9. What value of x satisfies x/4 + 7 = 12?
A. 20
B. 48
10. What value of x satisfies (2x + 1)/3 = x - 1?
A. -2
B. 2
11. The sum of three consecutive even integers is 90. What is the largest of the three?
A. 30
B. 28
12. A line on a coordinate graph passes through the points (1, 4) and (3, 10). What is the slope?
A. 1/3
B. 3
13. A number of pencils in a box must be more than 15, no more than 40, and a multiple of 6.
A. 18
B. 24`

describe('printedNumbersFor', () => {
  it('takes the number the page prints, not the one the model counted', () => {
    const numbers = printedNumbersFor(PAGE, [
      'What value of x satisfies x/4 + 7 = 12?',
      'What value of x satisfies (2x + 1)/3 = x - 1?',
      'The sum of three consecutive even integers is 90. What is the largest of the three?',
    ])

    expect(numbers).toEqual([9, 10, 11])
  })

  it('matches a prompt the extractor reflowed or truncated', () => {
    const numbers = printedNumbersFor(PAGE, [
      'A line on a coordinate graph passes through the points (1, 4)\nand (3, 10). What is the slope?',
    ])

    expect(numbers).toEqual([12])
  })

  it('gives null for a question the page does not print', () => {
    expect(printedNumbersFor(PAGE, ['A cyclist rides 12 km in 40 minutes.'])).toEqual([null])
  })

  it('refuses to identify a stem from too little text', () => {
    expect(printedNumbersFor(PAGE, ['What value of x'])).toEqual([null])
  })

  it('hands out each page number once', () => {
    const numbers = printedNumbersFor(PAGE, [
      'What value of x satisfies x/4 + 7 = 12?',
      'What value of x satisfies x/4 + 7 = 12?',
    ])

    expect(numbers[0]).toBe(9)
    expect(numbers[1]).toBeNull()
  })

  it('says nothing about a page with no numbering it can read', () => {
    expect(printedNumbersFor('', ['What value of x satisfies x/4 + 7 = 12?'])).toEqual([null])
    expect(
      printedNumbersFor('a page of prose with no numbered questions on it at all', [
        'What value of x satisfies x/4 + 7 = 12?',
      ]),
    ).toEqual([null])
  })
})
