import { describe, expect, it } from 'vitest'

import { restoreCurrency } from '@/lib/questions/money'

/**
 * Putting back a symbol, never inventing a number.
 *
 * These questions are already stored and the raw text was never kept, so this
 * is the only repair available short of re-reading the page. That makes the
 * false positives the thing to be careful about: a wrong insertion writes a
 * price into a question that never had one, and nothing downstream can tell.
 */
describe('restoreCurrency', () => {
  it('restores prices when another one in the question kept its symbol', () => {
    expect(
      restoreCurrency(
        'Adult tickets cost 8 and child tickets cost 5. A total of 30 tickets were sold for $210.',
      ),
    ).toBe(
      'Adult tickets cost $8 and child tickets cost $5. A total of 30 tickets were sold for $210.',
    )
  })

  // Nothing in this one kept a symbol, so two decimal places is the evidence.
  it('restores a price written to the penny', () => {
    expect(restoreCurrency('Two apples and three bananas cost 2.20.')).toBe(
      'Two apples and three bananas cost $2.20.',
    )
  })

  it('leaves a whole number alone when nothing says money', () => {
    expect(restoreCurrency('The three prizes cost 5 tokens between them.')).toBeNull()
  })

  /*
   * The one that would have corrupted a question nobody had damaged. This
   * matches the verb, sits in a question holding a real price, and is a rate.
   */
  it('never prices a percentage', () => {
    expect(
      restoreCurrency('A deposit of $1,000 earns 10% annual interest, compounded annually.'),
    ).toBeNull()
  })

  it('never prices a count or a duration', () => {
    expect(restoreCurrency('The bond was held for 2 years and paid $50.')).toBeNull()
    expect(restoreCurrency('She paid $12 for 3 tickets.')).toBeNull()
  })

  it('reports nothing to do rather than an unchanged string', () => {
    expect(restoreCurrency('What is 2 + 2?')).toBeNull()
    expect(restoreCurrency('Sam has $5 and Ana has $12.')).toBeNull()
  })
})
