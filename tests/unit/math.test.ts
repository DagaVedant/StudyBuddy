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

  /*
   * A bare brace is set-builder or interval notation the model wrote on
   * purpose, not leftover markup. It used to flag any brace at all, which
   * meant every question written this way printed as "UNRENDERED MATH" in
   * the audit script even though nothing was wrong.
   */
  it('does not flag set-builder or interval notation', () => {
    expect(looksUnrendered('Let S = {1, 2, 3}. How many subsets does S have?')).toBe(
      false,
    )
    expect(looksUnrendered('The domain is {x | x > 0}.')).toBe(false)
    expect(looksUnrendered('f(x) = {2x if x > 0, -x otherwise}')).toBe(false)
  })

  // The shape a brace-only bug actually takes: `\left\{...\right\}` has its
  // `\left`/`\right` stripped by normalizeMath, leaving a literal `\{...\}`
  // behind that nothing else touches. That backslash is the tell a bare
  // brace does not carry.
  it('still flags a backslash-escaped brace normalizeMath could not reach', () => {
    expect(looksUnrendered('Solve \\{x : x > 0\\}')).toBe(true)
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

  /*
   * These used to be lost, and one of them was recorded here as a known
   * failure: a price with an operator between it and the next price read as
   * maths and unwrapped. It was filed as one odd case and it was a family.
   * A unit rate is the same shape, and unit rates are as ordinary at this
   * level as two-price sentences.
   *
   * What tells them apart is the character past the closing dollar. That
   * dollar is opening the next price, so a digit follows it, which is not
   * something a genuine maths span does.
   */
  it('keeps a price separated from the next one by an operator', () => {
    expect(normalizeMath('It costs $5 + tax, or $12 delivered.')).toBe(
      'It costs $5 + tax, or $12 delivered.',
    )
    expect(normalizeMath('The total was $40 = $25 + $15.')).toBe(
      'The total was $40 = $25 + $15.',
    )
  })

  it('keeps a unit rate, where the slash reads as maths', () => {
    expect(normalizeMath('She earns $15/hour and he earns $18/hour.')).toBe(
      'She earns $15/hour and he earns $18/hour.',
    )
    expect(normalizeMath('Apples are $3.50/lb and pears are $2.00/lb.')).toBe(
      'Apples are $3.50/lb and pears are $2.00/lb.',
    )
  })
})
