import { describe, expect, it } from 'vitest'

import { planPageReplacement } from '@/lib/worker/review'

const PAGE = `9. What value of x satisfies x/4 + 7 = 12?
A. 20
B. 48
10. What value of x satisfies (2x + 1)/3 = x - 1?
A. -2
B. 2
11. The sum of three consecutive even integers is 90. What is the largest of the three?
A. 30
B. 28`

const fresh = (ordinal: number, prompt_text: string) => ({ ordinal, prompt_text })

describe('planPageReplacement', () => {
  // The case the old matching could not see. A page re-read on its own counts
  // from 1, so comparing the model's count against the stored printed numbers
  // matched nothing and the review did nothing, silently.
  it('matches a re-read that counted from 1 against the page numbering', () => {
    const plan = planPageReplacement(
      PAGE,
      [
        fresh(1, 'What value of x satisfies x/4 + 7 = 12?'),
        fresh(2, 'What value of x satisfies (2x + 1)/3 = x - 1?'),
      ],
      [
        { id: 'a', printedNumber: 9 },
        { id: 'b', printedNumber: 10 },
      ],
    )

    expect(plan.replace.map((row) => row.id)).toEqual(['a', 'b'])
    expect(plan.keep).toEqual([])
    expect(plan.replacements).toHaveLength(2)
  })

  it('keeps a doubted question the second read did not bring back', () => {
    const plan = planPageReplacement(
      PAGE,
      [fresh(1, 'What value of x satisfies x/4 + 7 = 12?')],
      [
        { id: 'a', printedNumber: 9 },
        { id: 'b', printedNumber: 11 },
      ],
    )

    expect(plan.replace.map((row) => row.id)).toEqual(['a'])
    expect(plan.keep.map((row) => row.id)).toEqual(['b'])
  })

  // Writing the whole page back is how a re-read used to add a second copy of
  // questions nobody doubted: the text differs by a character, so the hash
  // differs and the dedupe cannot see it.
  it('returns only the questions standing in for something deleted', () => {
    const plan = planPageReplacement(
      PAGE,
      [
        fresh(1, 'What value of x satisfies x/4 + 7 = 12?'),
        fresh(2, 'What value of x satisfies (2x + 1)/3 = x - 1?'),
        fresh(3, 'The sum of three consecutive even integers is 90. What is the largest of the three?'),
      ],
      [{ id: 'a', printedNumber: 10 }],
    )

    expect(plan.replacements.map((q) => q.prompt_text)).toEqual([
      'What value of x satisfies (2x + 1)/3 = x - 1?',
    ])
  })

  it('falls back to the model count when the page prints no numbering', () => {
    const plan = planPageReplacement(
      '',
      [fresh(4, 'A rectangular garden measures 12 m by 8 m. What is its area?')],
      [{ id: 'a', printedNumber: 4 }],
    )

    expect(plan.replace.map((row) => row.id)).toEqual(['a'])
  })

  it('deletes nothing when the second read came back empty', () => {
    const plan = planPageReplacement(PAGE, [], [{ id: 'a', printedNumber: 9 }])

    expect(plan.replace).toEqual([])
    expect(plan.keep.map((row) => row.id)).toEqual(['a'])
    expect(plan.replacements).toEqual([])
  })
})
