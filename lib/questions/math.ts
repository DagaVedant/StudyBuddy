export const ESCAPE_COLLIDING_COMMANDS = new Set([
  'bar', 'begin', 'binom', 'bmod', 'boxed', 'bullet',
  'forall', 'frac',
  'nabla', 'ne', 'neg', 'neq', 'ngeq', 'nleq', 'nmid', 'notin', 'nu',
  'rangle', 'rceil', 'rfloor', 'rho', 'right', 'rightarrow',
  'tan', 'text', 'textbf', 'textit', 'tfrac', 'theta', 'times', 'triangle',
  'underbrace', 'underline', 'uparrow',
])

const LETTER_FOR_CONTROL = new Map([
  ['\u0008', 'b'],
  ['\u000c', 'f'],
  ['\n', 'n'],
  ['\r', 'r'],
  ['\t', 't'],
])

function recoverEatenCommands(text: string): string {
  return text.replace(/[\u0008\u000c\n\r\t]([a-zA-Z]+)/g, (match, run: string) => {
    const command = `${LETTER_FOR_CONTROL.get(match[0])}${run}`
    return ESCAPE_COLLIDING_COMMANDS.has(command) ? `\\${command}` : match
  })
}

const DELIMITERS: [RegExp, string][] = [
  [/\\\[([\s\S]*?)\\\]/g, '$1'],
  [/\\\(([\s\S]*?)\\\)/g, '$1'],
  [/\$\$([\s\S]*?)\$\$/g, '$1'],
]

const LOOKS_LIKE_MATHS = /[\\=<>+*/^_{}×÷≤≥≠≈±√π−]/

function unwrapInlineMath(text: string): string {
  return text.replace(
    /\$([^$\n]+)\$/g,
    (match, inner: string, offset: number, whole: string) => {
      if (/^\d/.test(inner) && /\d/.test(whole[offset + match.length] ?? '')) {
        return match
      }

      return !/\s/.test(inner) || LOOKS_LIKE_MATHS.test(inner) ? inner : match
    },
  )
}

const COMMANDS: [RegExp, string][] = [
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
  let text = recoverEatenCommands(input)

  for (let pass = 0; pass < 2; pass += 1) {
    for (const [pattern, replacement] of DELIMITERS) text = text.replace(pattern, replacement)
    text = unwrapInlineMath(text)
    for (const [pattern, replacement] of COMMANDS) text = text.replace(pattern, replacement)
  }

  text = text
    .replace(/\^\s*\{([^{}]*)\}/g, '^$1')
    .replace(/_\s*\{([^{}]*)\}/g, '_$1')
    .replace(/[˙̇]/g, '')
    .replace(/\\([a-zA-Z]+)/g, '$1')
    .replace(/[\u0008\u000c]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.;:?!])/g, '$1')

  return text.trim()
}

export function looksUnrendered(text: string): boolean {
  return /\\[a-zA-Z]+|\\\(|\\\)|\$\$|\\\{|\\\}|[\u0008\u000c]/.test(text)
}
