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

/**
 * The LaTeX commands whose names start with a letter JSON reads as an escape.
 *
 * `{"prompt":"\frac{44}{11}"}` is well-formed JSON. `\f` is a form feed, so
 * `JSON.parse` returns a control character followed by `rac` and the fraction
 * is destroyed before anything here can see it: no throw, no warning, just a
 * question the student reads as `?rac{44}{11}`. Only `b f n r t u` collide;
 * every other letter makes the parse fail loudly instead.
 *
 * Matched whole and never by prefix, because those escapes are also used for
 * what they actually mean. A real line break followed by prose gives a letter
 * run like `nline`, which is in no list here and stays a line break.
 */
export const ESCAPE_COLLIDING_COMMANDS = new Set([
  'bar', 'begin', 'binom', 'bmod', 'boxed', 'bullet',
  'forall', 'frac',
  'nabla', 'ne', 'neg', 'neq', 'ngeq', 'nleq', 'nmid', 'notin', 'nu',
  'rangle', 'rceil', 'rfloor', 'rho', 'right', 'rightarrow',
  'tan', 'text', 'textbf', 'textit', 'tfrac', 'theta', 'times', 'triangle',
  'underbrace', 'underline', 'uparrow',
])

/** The letter each escape was written with, keyed by what it decoded to. */
const LETTER_FOR_CONTROL = new Map([
  ['\u0008', 'b'],
  ['\u000c', 'f'],
  ['\n', 'n'],
  ['\r', 'r'],
  ['\t', 't'],
])

/**
 * Puts back a command a JSON parser ate.
 *
 * Guards the pipeline rather than replacing the repair in `lib/ai/json.ts`:
 * text reaches this file from stored rows too, and those were written before
 * that repair existed.
 */
function recoverEatenCommands(text: string): string {
  return text.replace(/[\u0008\u000c\n\r\t]([a-zA-Z]+)/g, (match, run: string) => {
    const command = `${LETTER_FOR_CONTROL.get(match[0])}${run}`
    return ESCAPE_COLLIDING_COMMANDS.has(command) ? `\\${command}` : match
  })
}

/** LaTeX wrappers, which carry no meaning once the contents are readable. */
const DELIMITERS: [RegExp, string][] = [
  [/\\\[([\s\S]*?)\\\]/g, '$1'],
  [/\\\(([\s\S]*?)\\\)/g, '$1'],
  [/\$\$([\s\S]*?)\$\$/g, '$1'],
  [/\$([^$\n]+)\$/g, '$1'],
]

const COMMANDS: [RegExp, string][] = [
  // Fractions first: the inner groups must survive for the rest to see them.
  [/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$1/$2'],
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
  // Before anything else, because every rule below looks for a backslash and
  // a command a JSON parser ate no longer has one.
  let text = recoverEatenCommands(input)

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
    // Whatever the recovery above left behind was a control character in the
    // middle of a sentence, which has no reading at all.
    .replace(/[\u0008\u000c]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.;:?!])/g, '$1')

  return text.trim()
}

/** True when the text still carries notation a reader should not see. */
export function looksUnrendered(text: string): boolean {
  // The control characters are the eaten-command case: no backslash survives,
  // so the braces are usually the only tell, and a command taking no argument
  // leaves not even those.
  return /\\[a-zA-Z]+|\\\(|\\\)|\$\$|\{|\}|[\u0008\u000c]/.test(text)
}
