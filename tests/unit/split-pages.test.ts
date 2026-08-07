import { describe, expect, it } from 'vitest'

import { planPageSplitJoins, type SplitHalf } from '@/lib/questions/split-pages'

/**
 * Taken verbatim from the AMC8 2024 extraction that exposed this. Question 11
 * ends at the foot of page 2; its figure and its five options open page 3, and
 * came back as a row of their own.
 */
const STEM: SplitHalf = {
  id: 'stem',
  pageNumber: 2,
  position: 11,
  top: 1165,
  printedNumber: 11,
  promptText:
    'The coordinates of △ ABC are A (5, 7), B (11, 7), C (3, y ), with y > 7. ' +
    'The area of △ ABC is 12. What is the value of y?',
  questionType: 'multiple_choice',
  choices: [],
}

/**
 * Its position is 15 and its bbox top is 246. Both are real: the row was
 * written last because it came out of a re-read, but it is printed at the very
 * top of page 3, above question 12 at 639. Geometry is what says so.
 */
const ORPHAN: SplitHalf = {
  id: 'orphan',
  pageNumber: 3,
  position: 15,
  top: 246,
  printedNumber: null,
  promptText: 'C(3,y)nA(5,7) B(11,7)',
  questionType: 'multiple_choice',
  choices: [
    { label: 'A', text: '8' },
    { label: 'B', text: '9' },
    { label: 'C', text: '10' },
    { label: 'D', text: '11' },
    { label: 'E', text: '12' },
  ],
}

/** The next real question on page 3, which must never be touched. */
const NEXT: SplitHalf = {
  id: 'guppies',
  pageNumber: 3,
  position: 13,
  top: 639,
  printedNumber: 12,
  promptText:
    'Rohan keeps a total of 90 guppies in 4 fish tanks. There is 1 more guppy in ' +
    'the 2nd tank than the 1st tank. How many guppies are in the 4th tank?',
  questionType: 'multiple_choice',
  choices: [
    { label: 'A', text: '20' },
    { label: 'B', text: '21' },
    { label: 'C', text: '23' },
    { label: 'D', text: '24' },
    { label: 'E', text: '26' },
  ],
}

function join(questions: SplitHalf[], expectedChoiceCount: number | null = 5) {
  return planPageSplitJoins(questions, { expectedChoiceCount })
}

describe('planPageSplitJoins', () => {
  it('rejoins a stem at the foot of one page with the options at the head of the next', () => {
    const plans = join([STEM, ORPHAN, NEXT])

    expect(plans).toHaveLength(1)
    expect(plans[0].keepId).toBe('stem')
    expect(plans[0].dropId).toBe('orphan')
  })

  it('keeps the printed number, which only the stem half carried', () => {
    expect(join([STEM, ORPHAN])[0].printedNumber).toBe(11)
  })

  it('takes the printed number from the orphan when the stem lost it', () => {
    const plans = join([{ ...STEM, printedNumber: null }, { ...ORPHAN, printedNumber: 11 }])

    expect(plans[0].printedNumber).toBe(11)
  })

  it('does not care which order the rows arrive in', () => {
    expect(join([NEXT, ORPHAN, STEM])).toHaveLength(1)
  })

  // Everything below is a case where joining would destroy a real question.

  it('leaves a stem that already has its own options', () => {
    expect(join([{ ...STEM, choices: ORPHAN.choices }, ORPHAN])).toHaveLength(0)
  })

  it('leaves an orphan that is really a question in its own right', () => {
    // Same shape — first on the page, full option list — but it asks something,
    // so the options are its own.
    expect(join([STEM, { ...ORPHAN, promptText: NEXT.promptText }])).toHaveLength(0)
  })

  it('leaves a pair whose printed numbers say they are different questions', () => {
    expect(join([STEM, { ...ORPHAN, printedNumber: 12 }])).toHaveLength(0)
  })

  it('leaves the orphan alone when it is not the first thing on its page', () => {
    // Options belonging to page 2 cannot appear below a question that is
    // itself printed on page 3.
    expect(join([STEM, { ...ORPHAN, top: 1400 }, NEXT])).toHaveLength(0)
  })

  it('leaves a stem that is not the last thing on its page', () => {
    expect(join([STEM, { ...NEXT, pageNumber: 2, top: 1400 }, ORPHAN])).toHaveLength(0)
  })

  // Ordinals put the orphan third on page 3, because it was written last by a
  // re-read. Reading it off the page instead is the whole reason geometry is
  // preferred, so the join has to survive a position that says otherwise.
  it('trusts the printed layout over the order the rows were written', () => {
    expect(join([STEM, ORPHAN, NEXT])).toHaveLength(1)
    expect(ORPHAN.position).toBeGreaterThan(NEXT.position)
  })

  it('falls back to arrival order when the page carries no geometry', () => {
    const flat = [STEM, ORPHAN, NEXT].map((q) => ({ ...q, top: null }))

    // Ordinal order is orphan-last here, so without geometry there is nothing
    // to say the options are printed above question 12, and it refuses.
    expect(join(flat)).toHaveLength(0)
    expect(join(flat.map((q) => (q.id === 'orphan' ? { ...q, position: 12 } : q)))).toHaveLength(1)
  })

  it('ignores geometry on a page where any question is missing it', () => {
    // Half a page of coordinates is worse than none: a row with no bbox would
    // sort to one end of the page on no evidence.
    const partial = [STEM, ORPHAN, { ...NEXT, top: null }]

    expect(join(partial)).toHaveLength(0)
  })

  it('refuses across a page that produced nothing', () => {
    // The options are on the blank page in between, so a row two pages later
    // is a different question however much it looks the part.
    expect(join([STEM, { ...ORPHAN, pageNumber: 4 }])).toHaveLength(0)
  })

  it('refuses a partial option list, where the answers were split as well', () => {
    expect(join([STEM, { ...ORPHAN, choices: ORPHAN.choices.slice(0, 3) }])).toHaveLength(0)
  })

  it('accepts a short option list when the paper has no settled option count', () => {
    const plans = join([STEM, { ...ORPHAN, choices: ORPHAN.choices.slice(0, 3) }], null)

    expect(plans).toHaveLength(1)
  })

  it('leaves a free-response stem, which is allowed to have no options', () => {
    expect(join([{ ...STEM, questionType: 'free_response' }, ORPHAN])).toHaveLength(0)
  })

  it('leaves a stem that asks nothing itself', () => {
    // Two rows of page furniture in a row is not a split question, and the
    // first one has no stem worth keeping.
    expect(join([{ ...STEM, promptText: 'CONTINUE ON TO THE NEXT PAGE' }, ORPHAN])).toHaveLength(0)
  })

  it('leaves a lone stray option under an orphan', () => {
    expect(join([STEM, { ...ORPHAN, choices: ORPHAN.choices.slice(0, 1) }], null)).toHaveLength(0)
  })

  it('ignores questions with no page, which cannot be placed either side of a break', () => {
    expect(join([{ ...STEM, pageNumber: null }, { ...ORPHAN, pageNumber: null }])).toHaveLength(0)
  })

  it('joins at most one pair per page boundary', () => {
    const plans = join([
      STEM,
      ORPHAN,
      NEXT,
      { ...STEM, id: 'stem2', pageNumber: 3, position: 14, top: 1400, printedNumber: 13 },
      { ...ORPHAN, id: 'orphan2', pageNumber: 4, position: 16 },
    ])

    expect(plans).toHaveLength(2)
    expect(plans.map((p) => p.dropId)).toEqual(['orphan', 'orphan2'])
  })
})
