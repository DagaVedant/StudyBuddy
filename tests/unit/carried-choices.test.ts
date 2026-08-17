import { describe, expect, it } from 'vitest'

import { parseCarriedChoices } from '@/lib/questions/carried-choices-plan'

const PAGE_4 = `AoPS Community 2024 AMC 8 -
(A) 28 (B) 29 (C) 30 (D) 31 (E) 32
15 Let the letters F , L , Y , B , U , G represent different digits. Suppose F LY F LY is the largest num-
ber that satisfies the equation
8 · F LY F LY = BU GBU G.
What is the value of F LY + BU G ?
(A) 1089 (B) 1098 (C) 1107 (D) 1116 (E) 1125`

const PAGE_5 = `AoPS Community 2024 AMC 8 -
B
O
C
(A) 108 (B) 120 (C) 135 (D) 144 (E) 150
19 Jordan owns 15 pairs of sneakers. Three fifths of the pairs are red and the rest are white.`

const PAGE_6 = `AoPS Community 2024 AMC 8 -
21 A group of frogs (called an army) is living in a tree. A frog turns green when in the shade and
yellow when in the sun. What is the difference between the number of green and yellow frogs?
(A) 10 (B) 12 (C) 16 (D) 20 (E) 24`

const labels = (page: string, expectedCount: number | null = 5) =>
  parseCarriedChoices(page, { expectedCount })?.map((c) => `${c.label}${c.text}`) ?? null

describe('parseCarriedChoices', () => {
  it('reads the options a page break left at the top of the next page', () => {
    expect(labels(PAGE_4)).toEqual(['A28', 'B29', 'C30', 'D31', 'E32'])
  })

  it('reads past a figure printed between the header and the options', () => {
    expect(labels(PAGE_5)).toEqual(['A108', 'B120', 'C135', 'D144', 'E150'])
  })

  it('takes nothing from a page whose first question is its own', () => {
    expect(labels(PAGE_6)).toBeNull()
  })

  it('takes only the first block, not the one under question 15', () => {
    expect(labels(PAGE_4)).not.toContain('A1089')
  })

  it('reads the dotted style as well as the bracketed one', () => {
    const page = `Practice Set 3\nA. seven\nB. eight\nC. nine\nD. ten\n4. How many sides does it have?`

    expect(labels(page, 4)).toEqual(['Aseven', 'Beight', 'Cnine', 'Dten'])
  })

  it('refuses a run that does not start at A', () => {
    const page = `AoPS Community\n(C) 30 (D) 31 (E) 32\n15 Let the letters represent different digits.`

    expect(labels(page, 3)).toBeNull()
  })

  it('refuses a run with a gap in it', () => {
    const page = `AoPS Community\n(A) 28 (B) 29 (D) 31 (E) 32\n15 Let the letters represent digits.`

    expect(labels(page, 5)).toBeNull()
  })

  it('refuses a run shorter than the paper uses', () => {
    const page = `AoPS Community\n(A) 28 (B) 29 (C) 30\n15 Let the letters represent digits.`

    expect(labels(page, 5)).toBeNull()
  })

  it('refuses fewer than three options however the paper is laid out', () => {
    const page = `AoPS Community\n(A) 28 (B) 29\n15 Let the letters represent digits.`

    expect(labels(page, null)).toBeNull()
  })

  it('refuses an empty page', () => {
    expect(labels('')).toBeNull()
    expect(labels('   \n  ')).toBeNull()
  })

  it('is not fooled by figures made of numbers', () => {
    const page = `AoPS Community 2024 AMC 8 -\n5 2 6 5\n8 14 10\n(A) 28 (B) 29 (C) 30 (D) 31 (E) 32\n15 Let the letters represent different digits here.`

    expect(labels(page)).toEqual(['A28', 'B29', 'C30', 'D31', 'E32'])
  })

  it('ignores letters that are not options', () => {
    const page = `SAMPLE ANSWER MARKS\nA B C D RIGHT\nA B C D WRONG\n1. What is the capital of France?`

    expect(labels(page, 4)).toBeNull()
  })

  it('refuses an option carrying a paragraph rather than an answer', () => {
    const page =
      `Header\n(A) ${'word '.repeat(80)}\n(B) short\n(C) shorter\n(D) shortest\n` +
      `4. Which is best?`

    expect(labels(page, 4)).toBeNull()
  })

  it('does not read options out of the middle of a sentence', () => {
    const page = `The grade. A. student may bring a. pencil and b. paper to the exam room.\n1. What is needed?`

    expect(labels(page, null)).toBeNull()
  })
})

describe('parseCarriedChoices, where the break fell inside the list', () => {
  const tail = (page: string, held: string[], expectedCount: number | null = 4) =>
    parseCarriedChoices(page, { expectedCount, held })?.map((c) => `${c.label}${c.text}`) ?? null

  const PAGE_2 = `B. 314
C. 25
D. 79
8. Two parallel lines are cut by a transversal, and one of the angles measures 65 degrees.
A. 65
B. 115`

  it('reads the run that starts at the label the question is missing', () => {
    expect(tail(PAGE_2, ['A'])).toEqual(['B314', 'C25', 'D79'])
  })

  it('reads a run of one, which is all a question holding three needs', () => {
    const page = `D. 13\n15. A rectangle has a perimeter of 40 cm and a width of 8 cm. What is its area?`

    expect(tail(page, ['A', 'B', 'C'])).toEqual(['D13'])
  })

  it('reads a run of two', () => {
    const page = `C. 17\nD. 34\n15. What is the median of the data set shown in the table above?`

    expect(tail(page, ['A', 'B'])).toEqual(['C17', 'D34'])
  })

  it('refuses a run that does not begin where the question left off', () => {
    expect(tail(`C. 25\nD. 79\n8. Two parallel lines are cut by a transversal here.`, ['A'])).toBeNull()
  })

  it('refuses a run that does not finish the question off', () => {
    expect(tail(`B. 314\nC. 25\n8. Two parallel lines are cut by a transversal here.`, ['A'])).toBeNull()
  })

  it('refuses to guess when the paper has no settled option count', () => {
    expect(tail(PAGE_2, ['A'], null)).toBeNull()
  })

  it('refuses a question whose kept options have a hole in them', () => {
    expect(tail(PAGE_2, ['A', 'C'])).toBeNull()
  })

  it('refuses a tail that is not the first thing on the page', () => {
    const page = `A. 12\nB. 314\nC. 25\nD. 79\n8. Two parallel lines are cut by a transversal here.`

    expect(tail(page, ['A'])).toBeNull()
  })

  it('leaves a question that already has everything alone', () => {
    expect(tail(PAGE_2, ['A', 'B', 'C', 'D'])).toBeNull()
  })
})
