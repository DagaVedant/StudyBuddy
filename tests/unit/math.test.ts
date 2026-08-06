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

  it('passes clean text', () => {
    expect(looksUnrendered('1/2% of x^2')).toBe(false)
    expect(looksUnrendered('The ribbon costs $5.00.')).toBe(false)
  })
})
