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
]

/** Characters that only turn up in maths, not in a sentence about money. */
const LOOKS_LIKE_MATHS = /[\\=<>+*/^_{}×÷≤≥≠≈±√π−]/

/**
 * Unwraps `$…$`, but only when what is inside is maths.
 *
 * This is also how money is written, and the plain rule matched from one price
 * to the next: "Sam has $5 and Ana has $12" came out as "Sam has 5 and Ana has
 * 12", turning a word problem about money into one about bare numbers. Verified
 * against a stored row rather than imagined. The paper says $5; the database
 * said 5.
 *
 * Two things say maths. A span with no whitespace in it is one token, so `$x$`,
 * `$x^2$` and `$3$` are wrappers around a symbol and never a price followed by
 * prose. A span with whitespace has to earn it by containing a character that
 * belongs to maths and not to English: a backslash command, an operator, a
 * relation. "5 and Ana has " has none of those.
 *
 * A plain hyphen is deliberately not on that list. It is a dash far more often
 * than it is a minus, and treating it as maths puts the money bug back.
 *
 * The costs are not symmetric, which is what settles the doubtful cases.
 * Leaving `$x$` wrapped shows a student a stray dollar sign: ugly, and they can
 * still read the question. Eating the dollar off a price changes what the
 * question asks and nothing downstream can tell.
 */
function unwrapInlineMath(text: string): string {
  return text.replace(
    /\$([^$\n]+)\$/g,
    (match, inner: string, offset: number, whole: string) => {
      /*
       * A closing `$` with a digit after it was never a closing `$`.
       *
       * The span runs from one dollar sign to the next, so a sentence pricing
       * two things hands this the prose between them. "Sam has $5 and Ana has
       * $12" was caught by the maths test below, because "5 and Ana has " holds
       * nothing mathematical. A unit rate is not: "She earns $15/hour and he
       * earns $18/hour" gives "15/hour and he earns ", and the slash is a
       * maths character, so both prices were eaten. So were the parts of an
       * equation written in money, "$40 = $25 + $15", on the `=`.
       *
       * Both are the same shape and it is one the reader can see: the run
       * starts with a digit and the character past the closing dollar is a
       * digit too, because that dollar is opening the next price. Genuine
       * inline maths does not end one span where the next begins with a
       * numeral, and if it ever does, the cost is a visible dollar sign rather
       * than a question that quietly asks something else.
       */
      if (/^\d/.test(inner) && /\d/.test(whole[offset + match.length] ?? '')) {
        return match
      }

      return !/\s/.test(inner) || LOOKS_LIKE_MATHS.test(inner) ? inner : match
    },
  )
}

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
    text = unwrapInlineMath(text)
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
