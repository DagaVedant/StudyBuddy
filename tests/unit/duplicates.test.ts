import { describe, expect, it } from 'vitest'

import { duplicatePrintedNumbers, planDuplicateMerges } from '@/lib/questions/duplicates'

const COMBINE = 'What is the best way to combine these sentences to clarify the relationship between ideas?'

// The three source sentences, and the four options built out of them. Taken
// from the page that exposed this: one question came back as two rows.
const SENTENCES = [
  { label: '1', text: 'The International Space Station has been inhabited by crew members since 2000.' },
  { label: '2', text: 'Tourists will soon be allowed to pay for visits to the space station.' },
  { label: '3', text: 'Because the cost is $52-$58 million round trip, few people will be able to take advantage of the opportunity.' },
]

const OPTIONS = [
  { label: 'A', text: 'The International Space Station has been inhabited by crew members since 2000, but tourists will soon be allowed to pay for visits to the space station, and because the cost is $52-$58 million round trip, few people will be able to take advantage of the opportunity.' },
  { label: 'B', text: 'The International Space Station has been inhabited by crew members since 2000 and tourists will soon be allowed to pay for visits to the space station, though because the cost is $52-$58 million round trip, few people will be able to take advantage of the opportunity.' },
  { label: 'C', text: 'The International Space Station has been inhabited by crew members since 2000, but tourists will soon be allowed to pay for visits to the space station, so because the cost is $52-$58 million round trip, few people will be able to take advantage of the opportunity.' },
  { label: 'D', text: 'The International Space Station has been inhabited by crew members since 2000, and tourists will soon be allowed to pay for visits to the space station because the cost is $52-$58 million round trip, few people will be able to take advantage of the opportunity.' },
]

describe('planDuplicateMerges', () => {
  it('merges the sentence list back into the question it belongs to', () => {
    const plans = planDuplicateMerges([
      { id: 'phantom', printedNumber: 1, promptText: COMBINE, choices: SENTENCES },
      { id: 'real', printedNumber: 2, promptText: COMBINE, choices: OPTIONS },
    ])

    expect(plans).toHaveLength(1)
    expect(plans[0].keepId).toBe('real')
    expect(plans[0].dropId).toBe('phantom')
  })

  // The phantom takes the lower number and shunts the real question into the
  // next one along. Handing the low number back is what repairs the numbering.
  it('gives the surviving row the lower of the two numbers', () => {
    const plans = planDuplicateMerges([
      { id: 'phantom', printedNumber: 1, promptText: COMBINE, choices: SENTENCES },
      { id: 'real', printedNumber: 2, promptText: COMBINE, choices: OPTIONS },
    ])

    expect(plans[0].printedNumber).toBe(1)
  })

  it('works whichever order the rows arrive in', () => {
    const plans = planDuplicateMerges([
      { id: 'real', printedNumber: 2, promptText: COMBINE, choices: OPTIONS },
      { id: 'phantom', printedNumber: 1, promptText: COMBINE, choices: SENTENCES },
    ])

    expect(plans[0].keepId).toBe('real')
  })

  // Everything below is a case where merging would destroy a real question.

  it('leaves two real questions that happen to share a stem', () => {
    // This stem repeats all over an SHSAT English section, with different
    // sentences each time. Both sides are proper lettered answer lists.
    const other = [
      { label: 'A', text: 'Marie Curie was born in Warsaw in 1867 and later moved to Paris to study physics.' },
      { label: 'B', text: 'Marie Curie, born in Warsaw in 1867, later moved to Paris, where she studied physics.' },
      { label: 'C', text: 'Born in Warsaw in 1867, Marie Curie moved to Paris and there she studied physics.' },
      { label: 'D', text: 'Marie Curie was born in Warsaw in 1867, she later moved to Paris to study physics.' },
    ]

    const plans = planDuplicateMerges([
      { id: 'q1', printedNumber: 1, promptText: COMBINE, choices: OPTIONS },
      { id: 'q2', printedNumber: 7, promptText: COMBINE, choices: other },
    ])

    expect(plans).toEqual([])
  })

  it('leaves a question whose answers are legitimately sentence numbers', () => {
    // "Which sentence contains an error?" genuinely takes numbered answers.
    // Numeric labels alone must never be enough to delete a row.
    const plans = planDuplicateMerges([
      {
        id: 'errors',
        printedNumber: 2,
        promptText: 'Which sentence contains an error in its construction and should be revised?',
        choices: [
          { label: '1', text: 'In 1976, the National Basketball Association absorbed several teams.' },
          { label: '2', text: 'The owner of the Nets decided to take the team to New Jersey afterwards.' },
          { label: '3', text: 'The New Jersey Nets had sixteen playoff appearances over the years.' },
          { label: '4', text: 'In 2012, the team changed ownership and returned to New York City.' },
        ],
      },
    ])

    expect(plans).toEqual([])
  })

  it('leaves a pair whose choices are unrelated, even with matching labels', () => {
    const plans = planDuplicateMerges([
      { id: 'a', printedNumber: 1, promptText: COMBINE, choices: SENTENCES },
      {
        id: 'b',
        printedNumber: 2,
        promptText: COMBINE,
        choices: [
          { label: 'A', text: 'Photosynthesis converts light energy into chemical energy in plants.' },
          { label: 'B', text: 'Cellular respiration releases energy stored in glucose molecules.' },
          { label: 'C', text: 'Mitosis produces two genetically identical daughter cells.' },
          { label: 'D', text: 'Osmosis moves water across a semipermeable membrane.' },
        ],
      },
    ])

    expect(plans).toEqual([])
  })

  it('will not act on three or more rows sharing a prompt', () => {
    const plans = planDuplicateMerges([
      { id: 'a', printedNumber: 1, promptText: COMBINE, choices: SENTENCES },
      { id: 'b', printedNumber: 2, promptText: COMBINE, choices: OPTIONS },
      { id: 'c', printedNumber: 3, promptText: COMBINE, choices: OPTIONS },
    ])

    expect(plans).toEqual([])
  })

  it('ignores very short choice text that would match almost anything', () => {
    const plans = planDuplicateMerges([
      {
        id: 'short',
        printedNumber: 1,
        promptText: 'Solve for x.',
        choices: [
          { label: '1', text: '4' },
          { label: '2', text: '6' },
        ],
      },
      {
        id: 'real',
        printedNumber: 2,
        promptText: 'Solve for x.',
        choices: [
          { label: 'A', text: 'x equals 4 because both sides reduce evenly' },
          { label: 'B', text: 'x equals 6 after subtracting seven from each side' },
        ],
      },
    ])

    expect(plans).toEqual([])
  })

  it('leaves a lone question alone', () => {
    const plans = planDuplicateMerges([
      { id: 'only', printedNumber: 1, promptText: COMBINE, choices: OPTIONS },
    ])

    expect(plans).toEqual([])
  })
})

describe('duplicatePrintedNumbers', () => {
  it('spots a number used twice', () => {
    expect(
      duplicatePrintedNumbers([
        { printedNumber: 1 },
        { printedNumber: 2 },
        { printedNumber: 2 },
        { printedNumber: 3 },
      ]),
    ).toEqual([2])
  })

  it('says nothing about a clean run', () => {
    expect(
      duplicatePrintedNumbers([{ printedNumber: 1 }, { printedNumber: 2 }]),
    ).toEqual([])
  })

  it('does not treat unnumbered rows as colliding', () => {
    expect(
      duplicatePrintedNumbers([
        { printedNumber: null },
        { printedNumber: null },
        { printedNumber: 5 },
      ]),
    ).toEqual([])
  })
})
