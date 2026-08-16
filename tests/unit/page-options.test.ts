import { describe, expect, it } from 'vitest'

import { questionsOnPage } from '@/lib/questions/numbering'

/** edison_topic_test2_20 page 1, verbatim, down to where the page break falls. */
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

  /**
   * The page break falls inside question 7's option list. A short run is what
   * the carried-options recovery needs: a stem holding A, B and C is how it
   * knows to go and look for D at the top of the next page.
   */
  it('returns the short run a page break left behind', () => {
    expect(shown(PAGE_1, 7)).toEqual(['A. $45.00', 'B. $3.60', 'C. $49.50'])
  })

  /**
   * The question-start pattern in page-text.ts demands prose after the number,
   * so it misses both of these. That matters twice over: the question is
   * skipped, and because nothing marks where it begins, the option list above
   * it swallows the whole stem.
   */
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

  // Everything below would hand a question the wrong answers.

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
