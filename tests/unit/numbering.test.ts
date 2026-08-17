import { describe, expect, it } from 'vitest'
import { inferPrintedNumbers, printedNumbersFor, questionsOnPage, type NumberedQuestion } from '@/lib/questions/numbering'

describe('questionsOnPage', () => {
const PAGE_1 = `Edison Academy Magnet School
Section 2: Percents Practice
AMC 8 / MATHCOUNTS Style - No Calculator Permitted - 40 Minutes
1. A price is increased by 20% and then decreased by 20%. What is the net percent change from the
original price?
A. 0%
B. -20%
C. -4%
D. 4%
2. A jacket originally priced $80 is discounted 25%, and then the sale price is discounted an additional
10%. What is the final price?
A. $54
B. $60
C. $52
D. $72
7. A city's sales tax rate is 8%. What is the total cost, including tax, of an item priced at $45.00?
A. $45.00
B. $3.60
C. $49.50`

const find = (page: string, number: number) =>
  questionsOnPage(page).find((question) => question.number === number)

const shown = (page: string, number: number) =>
  find(page, number)?.options.map((option) => `${option.label}. ${option.text}`) ?? null

describe('questionsOnPage', () => {
  it('reads a question and the options printed under it', () => {
    expect(shown(PAGE_1, 1)).toEqual(['A. 0%', 'B. -20%', 'C. -4%', 'D. 4%'])
  })

  it('keeps the stem and leaves the options out of it', () => {
    expect(find(PAGE_1, 1)?.stem).toBe(
      'A price is increased by 20% and then decreased by 20%. What is the net percent change from the\noriginal price?',
    )
  })

  it('stops one question at the next, rather than running on', () => {
    expect(shown(PAGE_1, 2)).toEqual(['A. $54', 'B. $60', 'C. $52', 'D. $72'])
  })

  it('returns the short run a page break left behind', () => {
    expect(shown(PAGE_1, 7)).toEqual(['A. $45.00', 'B. $3.60', 'C. $49.50'])
  })

  it('finds a question that opens with a numeral', () => {
    const page = `10. A shirt costs $40 after a 20% discount. What was the original price?
A. $50
B. $48
11. 60 is what percent of 40?
A. 66.7%
B. 40%
C. 20%
D. 150%`

    expect(shown(page, 11)).toEqual(['A. 66.7%', 'B. 40%', 'C. 20%', 'D. 150%'])
    expect(shown(page, 10)).toEqual(['A. $50', 'B. $48'])
  })

  it('finds a question that opens with a currency symbol', () => {
    const page = `13. $1,000 is invested at 10% annual interest, compounded annually. What is the value of the
investment after 2 years?
A. $1,200
B. $1,100
C. $1,210
D. $1,221`

    expect(shown(page, 13)).toEqual(['A. $1,200', 'B. $1,100', 'C. $1,210', 'D. $1,221'])
  })

  it('keeps an option that wraps onto a second line whole', () => {
    const page = `4. Which statement best describes the result?
A. The total increases, because both factors grow
at the same rate
B. The total falls
C. The total is unchanged`

    expect(shown(page, 4)?.[0]).toBe(
      'A. The total increases, because both factors grow\nat the same rate',
    )
  })

  it('takes nothing from a block whose options do not start at A', () => {
    const page = `9. What is the remainder?
B. 4
C. 5
D. 6`

    expect(shown(page, 9)).toEqual([])
  })

  it('stops at a gap in the labels', () => {
    const page = `9. What is the remainder when 100 is divided by 7?
A. 2
B. 4
D. 6`

    expect(shown(page, 9)).toEqual(['A. 2', 'B. 4'])
  })

  it('ignores options run inline, which it cannot read apart from prose', () => {
    const page = `9. What is the remainder when 100 is divided by 7?
(A) 2 (B) 4 (C) 5 (D) 6`

    expect(shown(page, 9)).toEqual([])
  })

  it('refuses an option carrying a paragraph rather than an answer', () => {
    const page = `4. Which is best?\nA. ${'word '.repeat(80)}\nB. short\nC. shorter`

    expect(shown(page, 4)).toEqual([])
  })

  it('returns both blocks when a page prints one number twice', () => {
    const page = `5. 2 6 5
3. A rectangle has a perimeter of 40 cm. What is its area?
A. 96
B. 100
C. 84`

    expect(questionsOnPage(page).map((question) => question.number)).toEqual([5, 3])
    expect(shown(page, 3)).toEqual(['A. 96', 'B. 100', 'C. 84'])
  })

  it('says nothing about a page with no numbered lines', () => {
    expect(questionsOnPage('Edison Academy Magnet School\nPage 3 of 7')).toEqual([])
    expect(questionsOnPage('')).toEqual([])
  })
})
})

describe('printedNumbersFor', () => {
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
})

describe('inferPrintedNumbers', () => {
let seq = 0
function q(
  pageNumber: number | null,
  printedNumber: number | null,
  id = `q${(seq += 1)}`,
): NumberedQuestion {
  return { id, pageNumber, position: seq, printedNumber }
}

describe('inferPrintedNumbers', () => {
  it('fills a blank sitting in a gap of one', () => {
    const fixes = inferPrintedNumbers(
      [q(4, 3), q(5, null, 'blank'), q(8, 5)],
      114,
    )

    expect(fixes).toEqual([{ id: 'blank', from: null, to: 4, reason: 'filled-blank' }])
  })

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

  it('works without an expected total', () => {
    const fixes = inferPrintedNumbers([q(1, 1), q(2, null, 'a'), q(3, 3)], null)
    expect(fixes).toEqual([{ id: 'a', from: null, to: 2, reason: 'filled-blank' }])
  })

  it('does not renumber a duplicate that is in the right place', () => {
    expect(inferPrintedNumbers([q(1, 4), q(2, 5), q(2, 5), q(3, 6)], 6)).toEqual([])
  })
})
})
