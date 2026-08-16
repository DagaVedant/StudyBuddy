import { describe, expect, it } from 'vitest'

import {
  duplicatePrintedNumbers,
  planDuplicateMerges,
  planNumberDuplicateMerges,
  promptSimilarity,
} from '@/lib/questions/duplicates-plan'
import { questionInputSchema } from '@/lib/questions/shape'

describe('questionInputSchema through partial()', () => {
  it('leaves choices absent when a patch does not mention them', () => {
    // The PATCH route reads a present `choices` as "replace them with this".
    // A `.default([])` here survived `.partial()`, so a body that never
    // mentioned choices arrived as `[]` and deleted every answer on the
    // question. The verify screen sends exactly this body.
    const parsed = questionInputSchema.partial().parse({ userVerified: true })
    expect(parsed.choices).toBeUndefined()
  })

  it('still accepts choices when they are given', () => {
    const parsed = questionInputSchema.partial().parse({
      choices: [{ label: 'A', text: '75', isCorrect: true }],
    })
    expect(parsed.choices).toHaveLength(1)
  })
})

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

const FOUR = [
  { label: 'A', text: '4' },
  { label: 'B', text: '6' },
  { label: 'C', text: '9' },
  { label: 'D', text: '12' },
]

describe('planNumberDuplicateMerges', () => {
  it('folds one question read twice and transcribed differently', () => {
    const plans = planNumberDuplicateMerges(
      [
        {
          id: 'clean',
          printedNumber: 5,
          promptText: 'A ball is dropped from the top of a tower, and its height above the ground after t seconds is given by the expression shown.',
          choices: FOUR,
        },
        {
          id: 'damaged',
          printedNumber: 5,
          promptText: 'A ball is dropped from the top of a tower, and its height above the _ after t seconds is given by the expression shown.',
          choices: FOUR.slice(0, 2),
        },
      ],
      4,
    )

    expect(plans).toHaveLength(1)
    expect(plans[0].keepId).toBe('clean')
    expect(plans[0].dropId).toBe('damaged')
    expect(plans[0].printedNumber).toBe(5)
  })

  // The Edison failure. A page whose printed numbers the extractor could not
  // read comes back numbered from 1 by position, colliding with the page
  // before it. Deleting on the number alone destroyed six real questions on one
  // sheet and every count-based check still reported success.
  it('leaves two different questions that were handed the same number', () => {
    const plans = planNumberDuplicateMerges(
      [
        {
          id: 'page1',
          printedNumber: 3,
          promptText: 'What value of x satisfies 3x - 7 = 20?',
          choices: FOUR,
        },
        {
          id: 'page2',
          printedNumber: 3,
          promptText: 'What value of x satisfies 5(x - 3) = 2x + 9?',
          choices: FOUR,
        },
      ],
      4,
    )

    expect(plans).toEqual([])
  })

  it('leaves two questions sharing a number and nothing else', () => {
    const plans = planNumberDuplicateMerges(
      [
        {
          id: 'geometry',
          printedNumber: 8,
          promptText: 'Two parallel lines are cut by a transversal. One angle measures 65 degrees. What is its co-interior angle?',
          choices: FOUR,
        },
        {
          id: 'counting',
          printedNumber: 8,
          promptText: 'A pizza shop offers 7 toppings. How many different 3-topping pizzas can be made?',
          choices: FOUR,
        },
      ],
      4,
    )

    expect(plans).toEqual([])
  })

  it('still refuses to act on three or more rows sharing a number', () => {
    const same = 'A rectangular stage has a length that is 7 feet more than its width.'
    const plans = planNumberDuplicateMerges(
      [
        { id: 'a', printedNumber: 2, promptText: same, choices: FOUR },
        { id: 'b', printedNumber: 2, promptText: same, choices: FOUR },
        { id: 'c', printedNumber: 2, promptText: same, choices: FOUR },
      ],
      4,
    )

    expect(plans).toEqual([])
  })

  it('does not collide unnumbered rows with each other', () => {
    const plans = planNumberDuplicateMerges(
      [
        { id: 'a', printedNumber: null, promptText: 'One question.', choices: FOUR },
        { id: 'b', printedNumber: null, promptText: 'Another question.', choices: FOUR },
      ],
      4,
    )

    expect(plans).toEqual([])
  })

  /**
   * Why this guard is prompt similarity and not choice containment.
   *
   * The fix list asked for containment here, the same check `planDuplicateMerges`
   * uses, on the reasoning that it is what separates a phantom question from a
   * real one. Measured against the cases above it is the wrong instrument, and
   * not marginally: it folds nothing at all on a maths paper.
   *
   * `choicesAreContainedIn` requires a match of at least twelve characters,
   * because a shorter needle matches almost anything. That floor is right where
   * it is used: there the phantom's options are whole source sentences. Here the
   * options are "4", "6", "9", "12". Every one is below the floor, so the check
   * can never fire, and requiring it would mean never folding a re-read.
   *
   * Kept as a test rather than a comment because the next person to look at
   * the merge pass will have the same idea.
   */
  it('folds the re-read that a containment check would have missed', () => {
    const reread = [
      {
        id: 'clean',
        printedNumber: 5,
        promptText: 'A ball is dropped from the top of a tower, and its height above the ground after t seconds is given by the expression shown.',
        choices: FOUR,
      },
      {
        id: 'damaged',
        printedNumber: 5,
        promptText: 'A ball is dropped from the top of a tower, and its height above the _ after t seconds is given by the expression shown.',
        choices: FOUR.slice(0, 2),
      },
    ]

    // What the shipping rule sees: near-identical prompts.
    expect(promptSimilarity(reread[0].promptText, reread[1].promptText)).toBeGreaterThan(0.8)

    // What a containment rule would have seen: nothing long enough to compare.
    expect(FOUR.every((choice) => choice.text.length < 12)).toBe(true)

    expect(planNumberDuplicateMerges(reread, 4)).toHaveLength(1)
  })

  // The other half of the same argument. Similarity is what spares the Edison
  // collision, and it spares it by a wide margin rather than by a hair.
  it('separates the collision from the re-read by a wide margin', () => {
    const reread = promptSimilarity(
      'A ball is dropped from the top of a tower, and its height above the ground after t seconds is given by the expression shown.',
      'A ball is dropped from the top of a tower, and its height above the _ after t seconds is given by the expression shown.',
    )
    const collision = promptSimilarity(
      'What value of x satisfies 3x - 7 = 20?',
      'What value of x satisfies 5(x - 3) = 2x + 9?',
    )

    expect(reread).toBeGreaterThan(0.9)
    expect(collision).toBeLessThan(0.5)
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
