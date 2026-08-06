/**
 * Turns whatever notation the model reached for into readable plain text.
 *
 * One worksheet came back in three formats: `\( 8x - (7 + 2.5x) + 2 \)`,
 * `$\frac{1}{2}\%$`, and plain text carrying stray `˙` characters. None of
 * them render, so a student reads raw markup where the paper shows a fraction.
 *
 * Plain text rather than a maths renderer on purpose. These are grade 8
 * arithmetic and algebra questions whose notation is almost entirely fractions,
 * powers and the four operators, all of which read perfectly as `1/2` and
 * `x^2`. A renderer would mean a new dependency, its stylesheet, and a content
 * security policy exception, to make a small number of expressions marginally
 * prettier.
 */

/** LaTeX wrappers, which carry no meaning once the contents are readable. */
const DELIMITERS: [RegExp, string][] = [
  [/\\\[([\s\S]*?)\\\]/g, '$1'],
  [/\\\(([\s\S]*?)\\\)/g, '$1'],
  [/\$\$([\s\S]*?)\$\$/g, '$1'],
  [/\$([^$\n]+)\$/g, '$1'],
]

const COMMANDS: [RegExp, string][] = [
  // Fractions first: the inner groups must survive for the rest to see them.
  [/\\d?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$1/$2'],
  [/\\sqrt\s*\{([^{}]*)\}/g, '√($1)'],
  [/\\text\s*\{([^{}]*)\}/g, '$1'],
  [/\\mathrm\s*\{([^{}]*)\}/g, '$1'],

  [/\\times/g, '×'],
  [/\\div/g, '÷'],
  [/\\cdot/g, '·'],
  [/\\pm/g, '±'],
  [/\\leq/g, '≤'],
  [/\\geq/g, '≥'],
  [/\\neq/g, '≠'],
  [/\\approx/g, '≈'],
  [/\\pi/g, 'π'],
  [/\\degree|\\circ/g, '°'],
  [/\\%/g, '%'],
  [/\\\$/g, '$'],
  [/\\,|\\;|\\!|\\quad|\\qquad/g, ' '],
  [/\\left|\\right/g, ''],
]

export function normalizeMath(input: string): string {
  let text = input

  // Twice, because a fraction is routinely wrapped in delimiters that a single
  // pass strips only after the fraction inside has already been missed.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const [pattern, replacement] of DELIMITERS) text = text.replace(pattern, replacement)
    for (const [pattern, replacement] of COMMANDS) text = text.replace(pattern, replacement)
  }

  text = text
    // `x^{2}` reads as `x^2`; the braces only ever existed for the renderer.
    .replace(/\^\s*\{([^{}]*)\}/g, '^$1')
    .replace(/_\s*\{([^{}]*)\}/g, '_$1')
    // A dot above a digit is how the PDF text layer renders a fraction bar,
    // and it arrives as a character that means nothing on its own.
    .replace(/[˙̇]/g, '')
    // Anything left starting with a backslash is a command this does not know.
    // Dropping the backslash leaves the word, which beats showing the escape.
    .replace(/\\([a-zA-Z]+)/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.;:?!])/g, '$1')

  return text.trim()
}

/** True when the text still carries notation a reader should not see. */
export function looksUnrendered(text: string): boolean {
  return /\\[a-zA-Z]+|\\\(|\\\)|\$\$|\{|\}/.test(text)
}
