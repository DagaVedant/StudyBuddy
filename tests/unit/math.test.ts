import { describe, expect, it } from 'vitest'

import { looksUnrendered, normalizeMath } from '@/lib/questions/math'

describe('normalizeMath', () => {
  // The three shapes one real worksheet produced, in a single run.
  it('unwraps inline LaTeX delimiters', () => {
    expect(normalizeMath('Simplify: \\( 8x - (7 + 2.5x) + 2 \\)')).toBe(
      'Simplify: 8x - (7 + 2.5x) + 2',
    )
  })

  it('turns a dollar-wrapped fraction into readable text', () => {
    expect(normalizeMath('Jevon earns $\\frac{1}{2}\\%$ per year')).toBe(
      'Jevon earns 1/2% per year',
    )
  })

  it('drops the dot the PDF text layer uses for a fraction bar', () => {
    expect(normalizeMath('(1˙/7 - 1˙/6)')).toBe('(1/7 - 1/6)')
  })

  it('handles a fraction wrapped in delimiters', () => {
    expect(normalizeMath('\\(\\frac{3}{4}\\)')).toBe('3/4')
  })

  it('reads powers without their braces', () => {
    expect(normalizeMath('$x^{2} + y^{10}$')).toBe('x^2 + y^10')
  })

  it('converts the operators a student would recognise', () => {
    expect(normalizeMath('$3 \\times 4 \\div 2 \\neq 7$')).toBe('3 × 4 ÷ 2 ≠ 7')
  })

  it('keeps a square root legible', () => {
    expect(normalizeMath('\\(\\sqrt{16}\\)')).toBe('√(16)')
  })

  it('leaves ordinary prose completely alone', () => {
    const plain = 'Which sentence best states the central idea of the passage?'
    expect(normalizeMath(plain)).toBe(plain)
  })

  // A stray dollar sign is money far more often than it is maths.
  it('does not eat a price', () => {
    expect(normalizeMath('The ribbon costs $5.00 per metre.')).toBe(
      'The ribbon costs $5.00 per metre.',
    )
  })

  it('strips a command it does not know rather than showing the escape', () => {
    expect(normalizeMath('\\alpha + 1')).toBe('alpha + 1')
  })

  // The AMC8 question that shipped reading `?rac{44}{11}`: three fractions,
  // every backslash-f already swallowed by JSON.parse before ingest saw it.
  it('rebuilds a fraction a JSON parser ate', () => {
    const eaten = JSON.parse(
      '"What is the value of \\frac{44}{11}+\\frac{110}{44}+\\frac{44}{1100}?"',
    )
    expect(eaten).toContain(String.fromCharCode(12))
    expect(normalizeMath(eaten)).toBe('What is the value of 44/11+110/44+44/1100?')
  })

  it('rebuilds the other commands that decode to a control character', () => {
    const eaten = JSON.parse('"$3 \\times 4 \\neq 7$ and \\right)"')
    expect(normalizeMath(eaten)).toBe('3 × 4 ≠ 7 and )')
  })

  it('leaves a real line break as a line break', () => {
    expect(normalizeMath('Read the passage.\nnice work')).toBe(
      'Read the passage.\nnice work',
    )
    expect(normalizeMath('Choose one.\nThe answer is 4.')).toBe(
      'Choose one.\nThe answer is 4.',
    )
  })

  it('reads a display fraction the same as an inline one', () => {
    expect(normalizeMath('$\\dfrac{3}{4}$ and $\\tfrac{1}{2}$')).toBe('3/4 and 1/2')
  })

  it('is idempotent, so re-running it changes nothing', () => {
    const once = normalizeMath('$\\frac{1}{2}\\%$ of \\(x^{2}\\)')
    expect(normalizeMath(once)).toBe(once)
  })
})

describe('looksUnrendered', () => {
  it('spots notation a reader should not see', () => {
    expect(looksUnrendered('$\\frac{1}{2}$')).toBe(true)
    expect(looksUnrendered('\\( x \\)')).toBe(true)
  })

  it('spots a command a JSON parser ate', () => {
    expect(looksUnrendered(JSON.parse('"\\frac{1}{2}"'))).toBe(true)
  })

  it('passes clean text', () => {
    expect(looksUnrendered('1/2% of x^2')).toBe(false)
    expect(looksUnrendered('The ribbon costs $5.00.')).toBe(false)
    expect(looksUnrendered('Two lines.\nStill clean.')).toBe(false)
  })
})

/**
 * The single-dollar rule is also the money rule, and it used to lose.
 * Verified against a stored row: the paper said $5, the database said 5.
 */
describe('normalizeMath and money', () => {
  it('leaves prices alone', () => {
    for (const text of [
      'Sam has $5 and Ana has $12. How much more does Ana have?',
      'A shirt costs $20 and a hat costs $8.50.',
      'The bike was $1,200 before the $150 discount.',
      'She earns $15 an hour and he earns $18 an hour.',
    ]) {
      expect(normalizeMath(text), text).toBe(text)
    }
  })

  it('still unwraps a maths span that happens to open on a digit', () => {
    expect(normalizeMath('$3 \times 4$')).toBe('3 × 4')
    expect(normalizeMath('$2 + 2 = 4$')).toBe('2 + 2 = 4')
  })

  it('unwraps a single token, which is never a price followed by prose', () => {
    expect(normalizeMath('Solve for $x$.')).toBe('Solve for x.')
    expect(normalizeMath('$x^{2}$')).toBe('x^2')
  })

  // The one it gets wrong, recorded rather than hidden. A price with an
  // operator between it and the next price reads as maths, and unwraps. It is
  // the safer direction to be wrong in: a stray dollar sign is legible, a
  // missing one changes the question.
  it('is documented as fallible on a price next to an operator', () => {
    expect(normalizeMath('It costs $5 + tax, or $12 delivered.')).not.toContain('$5')
  })
})
