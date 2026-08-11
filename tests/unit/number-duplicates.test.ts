import { describe, expect, it } from 'vitest'

import {
  planNumberDuplicateMerges,
  type DuplicateCandidate,
} from '@/lib/questions/duplicates-plan'

/**
 * The only repair pass that deletes rows, and it had no tests.
 *
 * What it is for: a question read twice, transcribed slightly differently, so
 * the prompt hash does not match and the prompt-based rule cannot see it. What
 * it must never do is fold two genuinely different questions that happen to
 * share a printed number, because a page whose numbers the extractor failed to
 * read comes back numbered 1..n by position and collides with the real 1..n of
 * the page before it. That happened: six collisions on one Edison sheet, six
 * real questions gone, and every count-based check reporting success afterwards
 * because the totals still added up.
 *
 * So most of what follows is about what it declines to do.
 */

const FOUR = 4

function question(
  id: string,
  printedNumber: number | null,
  promptText: string,
  choices = ['4', '6', '9', '12'],
): DuplicateCandidate {
  return {
    id,
    printedNumber,
    promptText,
    choices: choices.map((text, index) => ({
      label: String.fromCharCode(65 + index),
      text,
    })),
  }
}

describe('planNumberDuplicateMerges', () => {
  it('folds a re-read of the same question', () => {
    const plans = planNumberDuplicateMerges(
      [
        question('a', 7, 'What is the area of a triangle with base 6 and height 4?'),
        question('b', 7, 'What is the area of a triangle with base 6 and height 4'),
      ],
      FOUR,
    )

    expect(plans).toEqual([{ keepId: 'a', dropId: 'b', printedNumber: 7 }])
  })

  it('does nothing when every number is held once', () => {
    expect(
      planNumberDuplicateMerges(
        [question('a', 1, 'What is 2 + 2?'), question('b', 2, 'What is 3 + 3?')],
        FOUR,
      ),
    ).toEqual([])
  })

  /**
   * The case that cost six questions. Two different questions numbered the
   * same is a numbering fault, and numbering faults are repaired by
   * renumbering. Deleting one of them destroys a question nobody can get back.
   */
  it('refuses to fold two different questions that share a number', () => {
    expect(
      planNumberDuplicateMerges(
        [
          question('a', 3, 'What is the area of a triangle with base 6 and height 4?'),
          question('b', 3, 'Solve for x: 3x plus 7 equals 22'),
        ],
        FOUR,
      ),
    ).toEqual([])
  })

  it('refuses a pair whose texts only half agree', () => {
    expect(
      planNumberDuplicateMerges(
        [
          question('a', 3, 'What is the area of a triangle with base 6 and height 4?'),
          question('b', 3, 'What is the area of a circle with radius 9 in terms of pi?'),
        ],
        FOUR,
      ),
    ).toEqual([])
  })

  /**
   * Pairs only. Three rows on one number is not a re-read, it is a page whose
   * numbering went wrong, and picking two of the three to merge would be a
   * guess about which two.
   */
  it('leaves a number held by three rows alone', () => {
    const same = 'What is the area of a triangle with base 6 and height 4?'

    expect(
      planNumberDuplicateMerges(
        [question('a', 5, same), question('b', 5, same), question('c', 5, same)],
        FOUR,
      ),
    ).toEqual([])
  })

  it('ignores questions with no printed number', () => {
    const same = 'What is the area of a triangle with base 6 and height 4?'

    expect(
      planNumberDuplicateMerges(
        [question('a', null, same), question('b', null, same)],
        FOUR,
      ),
    ).toEqual([])
  })

  describe('choosing which copy survives', () => {
    const intact = 'What is the value of 3 over 4 plus 1 over 8 in lowest terms?'

    it('keeps the copy with the expected number of choices', () => {
      const plans = planNumberDuplicateMerges(
        [
          question('damaged', 9, intact, ['4', '6']),
          question('whole', 9, intact),
        ],
        FOUR,
      )

      expect(plans[0]).toMatchObject({ keepId: 'whole', dropId: 'damaged' })
    })

    /**
     * A bare underscore is where a fraction bar was. The later copy being the
     * better one is why the survivor is chosen by damage rather than by
     * arrival order.
     */
    it('keeps the later copy when the earlier one lost a fraction bar', () => {
      const plans = planNumberDuplicateMerges(
        [
          question('first', 9, 'What is the value of 3 _ 4 plus 1 _ 8 in lowest terms?'),
          question('second', 9, intact),
        ],
        FOUR,
      )

      expect(plans[0]).toMatchObject({ keepId: 'second', dropId: 'first' })
    })

    it('keeps the copy that did not stop early', () => {
      const plans = planNumberDuplicateMerges(
        [question('whole', 9, intact), question('cut', 9, 'What is the')],
        FOUR,
      )

      // The truncated one is also too different to match, so this asserts the
      // pair is left alone rather than half-folded, which is the safe answer.
      expect(plans).toEqual([])
    })

    it('keeps the first when neither copy looks worse', () => {
      const plans = planNumberDuplicateMerges(
        [question('a', 9, intact), question('b', 9, `${intact} `)],
        FOUR,
      )

      expect(plans[0]).toMatchObject({ keepId: 'a', dropId: 'b' })
    })
  })

  it('hands back the number so the survivor can be renumbered to it', () => {
    const same = 'What is the area of a triangle with base 6 and height 4?'

    const plans = planNumberDuplicateMerges(
      [question('a', 12, same), question('b', 12, same)],
      FOUR,
    )

    expect(plans[0].printedNumber).toBe(12)
  })

  it('plans every duplicated number, not just the first', () => {
    const one = 'What is the area of a triangle with base 6 and height 4?'
    const two = 'What is the circumference of a circle with radius 5?'

    const plans = planNumberDuplicateMerges(
      [
        question('a1', 1, one),
        question('a2', 1, one),
        question('b1', 2, two),
        question('b2', 2, two),
      ],
      FOUR,
    )

    expect(plans.map((plan) => plan.printedNumber).sort()).toEqual([1, 2])
  })

  it('never names the same row as both survivor and casualty', () => {
    const same = 'What is the area of a triangle with base 6 and height 4?'

    const plans = planNumberDuplicateMerges(
      [question('a', 4, same), question('b', 4, same)],
      FOUR,
    )

    for (const plan of plans) expect(plan.keepId).not.toBe(plan.dropId)
  })
})
