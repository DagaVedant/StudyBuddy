import { createHash } from 'node:crypto'

import { z } from 'zod'

export const bboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()])

export function choiceLabel(raw: string): string {
  return raw.trim().replace(/^\(|[).\s]+$/g, '') || raw.trim()
}

export function normalizeChoiceLabel(label: string): string {
  const cleaned = label.trim().replace(/^[([]+/, '').replace(/[.)\]\s]+$/, '')
  const letterOnly = /^([A-Za-z])\s*[.):\]]\s*\S/.exec(cleaned)

  return (letterOnly?.[1] ?? (cleaned || label.trim())).slice(0, 8)
}

export const choiceSchema = z.object({
  label: z.string().trim().min(1).max(2000).transform(normalizeChoiceLabel),
  text: z.string().trim().max(2000),
  isCorrect: z.boolean().default(false),
})

export const questionInputSchema = z.object({
  pageId: z.string().min(1).nullish(),
  ordinal: z.number().int().min(1),
  promptText: z.string().trim().min(1).max(8000),
  questionType: z.enum([
    'multiple_choice',
    'free_response',
    'true_false',
    'fill_blank',
    'grid_in',
  ]),
  bbox: bboxSchema.nullish(),
  correctAnswer: z.string().trim().max(2000).nullish(),
  choices: z.array(choiceSchema).max(12).optional(),
  topicId: z.string().min(1).nullish(),
  userVerified: z.boolean().optional(),
})

export function normalizeForCompare(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

export function normalizeOptionText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/gu, '')
}

export function contentHashSource(promptText: string, choices: { text: string }[]): string {
  return [
    normalizeForCompare(promptText),
    ...choices.map((choice) => normalizeForCompare(choice.text)),
  ]
    .filter(Boolean)
    .join('|')
}

export function hashQuestion(promptText: string, choices: { text: string }[]): string {
  return createHash('sha256').update(contentHashSource(promptText, choices)).digest('hex')
}

export interface FoldableQuestion {
  prompt_text: string
  choices: { label: string; text: string }[]
}

const ALPHABETIC = /^[a-z]$/i
const NUMERIC = /^\d+$/

export function foldLeadInChoices<T extends FoldableQuestion>(question: T): T {
  const lettered = question.choices.filter((choice) =>
    ALPHABETIC.test(choice.label.trim()),
  )
  const numbered = question.choices.filter((choice) => NUMERIC.test(choice.label.trim()))

  if (lettered.length < 2 || numbered.length === 0) return question

  const stem = question.prompt_text.trim()
  const seen = new Set([normalizeForCompare(stem)].filter(Boolean))
  const lines: string[] = []

  for (const choice of [...numbered].sort(
    (a, b) => Number(a.label) - Number(b.label),
  )) {
    const text = choice.text.trim()
    if (!text) continue

    const normalized = normalizeForCompare(text)
    if (!normalized || [...seen].some((prior) => prior.includes(normalized))) continue

    seen.add(normalized)
    lines.push(`${Number(choice.label)}. ${text}`)
  }

  return {
    ...question,
    prompt_text: [stem, ...lines].join('\n'),
    choices: question.choices.filter((choice) => !NUMERIC.test(choice.label.trim())),
  }
}

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
