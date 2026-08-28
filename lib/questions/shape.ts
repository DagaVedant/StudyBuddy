import { createHash } from 'node:crypto'

import { z } from 'zod'

import {type BBox, type TextLine} from '@/lib/schema'

export const bboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()])

export function choiceLabel(raw: string): string {
  return raw.trim().replace(/^\(|[).\s]+$/g, '') || raw.trim()
}

export function normalizeChoiceLabel(label: string): string {
  const cleaned = label.trim().replace(/^[([]+/, '').replace(/[.)\]\s]+$/, '')
  const letterOnly = /^([A-Za-z])\s*[.):\]]\s*\S/.exec(cleaned)

  if (letterOnly) return letterOnly[1].slice(0, 8)
  if (cleaned) return cleaned.slice(0, 8)

  return label.trim().slice(0, 8)
}

const choiceSchema = z.object({
  label: z.string().trim().min(1).max(2000).transform(normalizeChoiceLabel),
  text: z.string().trim().max(2000),
  isCorrect: z.boolean().default(false),
})

export const questionInputSchema = z.object({
  pageId: z.string().min(1).nullish(),
  ordinal: z.number().int().min(1),
  promptText: z.string().trim().min(1).max(8000),
  questionType: z.enum([
    'multiple_choice', 'free_response', 'true_false', 'fill_blank', 'grid_in',
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

function contentHashSource(promptText: string, choices: { text: string }[]): string {
  const parts: string[] = []

  const stem = normalizeForCompare(promptText)
  if (stem) parts.push(stem)

  for (const choice of choices) {
    const text = normalizeForCompare(choice.text)
    if (text) parts.push(text)
  }

  return parts.join('|')
}

export function hashQuestion(promptText: string, choices: { text: string }[]): string {
  return createHash('sha256').update(contentHashSource(promptText, choices)).digest('hex')
}

export type FoldableQuestion = {
  prompt_text: string
  choices: { label: string; text: string }[]
}

const ALPHABETIC = /^[a-z]$/i
const NUMERIC = /^\d+$/

export function foldLeadInChoices<T extends FoldableQuestion>(question: T): T {
  let lettered = 0
  const numbered = []
  const kept = []

  for (const choice of question.choices) {
    const label = choice.label.trim()

    if (ALPHABETIC.test(label)) lettered = lettered + 1

    if (NUMERIC.test(label)) numbered.push(choice)
    else kept.push(choice)
  }

  if (lettered < 2 || numbered.length === 0) return question

  const stem = question.prompt_text.trim()

  const seen = new Set<string>()
  const stemText = normalizeForCompare(stem)
  if (stemText) seen.add(stemText)

  numbered.sort(function (a, b) {
    return Number(a.label) - Number(b.label)
  })

  const parts = [stem]

  for (const choice of numbered) {
    const text = choice.text.trim()
    if (!text) continue

    const normalized = normalizeForCompare(text)
    if (!normalized) continue

    let already = false
    for (const prior of seen) {
      if (prior.includes(normalized)) {
        already = true
        break
      }
    }

    if (already) continue

    seen.add(normalized)
    parts.push(Number(choice.label) + '. ' + text)
  }

  return {
    ...question,
    prompt_text: parts.join('\n'),
    choices: kept,
  }
}

export const ESCAPE_COLLIDING_COMMANDS = new Set([
  'bar', 'begin', 'binom', 'bmod', 'boxed', 'bullet', 'forall', 'frac', 'nabla', 'ne',
  'neg', 'neq', 'ngeq', 'nleq', 'nmid', 'notin', 'nu', 'rangle', 'rceil', 'rfloor', 'rho',
  'right', 'rightarrow', 'tan', 'text', 'textbf', 'textit', 'tfrac', 'theta', 'times',
  'triangle', 'underbrace', 'underline', 'uparrow',
])

const LETTER_FOR_CONTROL = new Map([
  ['\u0008', 'b'], ['\u000c', 'f'], ['\n', 'n'], ['\r', 'r'], ['\t', 't'],
])

function recoverEatenCommands(text: string): string {
  return text.replace(/[\u0008\u000c\n\r\t]([a-zA-Z]+)/g, (match, run: string) => {
    const command = (LETTER_FOR_CONTROL.get(match[0])) + run
    return ESCAPE_COLLIDING_COMMANDS.has(command) ? '\\' + command : match
  })
}

const DELIMITERS: [RegExp, string][] = [
  [/\\\[([\s\S]*?)\\\]/g, '$1'], [/\\\(([\s\S]*?)\\\)/g, '$1'],
  [/\$\$([\s\S]*?)\$\$/g, '$1'],
]

const LOOKS_LIKE_MATHS = /[\\=<>+*/^_{}×÷≤≥≠≈±√π−]/

function unwrapInlineMath(text: string): string {
  return text.replace(
    /\$([^$\n]+)\$/g,
    (match, inner: string, offset: number, whole: string) => {
      let after = whole[offset + match.length]
      if (!after) after = ''

      if (/^\d/.test(inner) && /\d/.test(after)) {
        return match
      }

      if (!/\s/.test(inner)) return inner
      if (LOOKS_LIKE_MATHS.test(inner)) return inner

      return match
    },
  )
}

const COMMANDS: [RegExp, string][] = [
  [/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$1/$2'],
  [/\\sqrt\s*\{([^{}]*)\}/g, '√($1)'], [/\\text\s*\{([^{}]*)\}/g, '$1'],
  [/\\mathrm\s*\{([^{}]*)\}/g, '$1'], [/\\times/g, '×'], [/\\div/g, '÷'], [/\\cdot/g, '·'],
  [/\\pm/g, '±'], [/\\leq/g, '≤'], [/\\geq/g, '≥'], [/\\neq/g, '≠'], [/\\approx/g, '≈'],
  [/\\pi/g, 'π'], [/\\degree|\\circ/g, '°'], [/\\%/g, '%'], [/\\\$/g, '$'],
  [/\\,|\\;|\\!|\\quad|\\qquad/g, ' '], [/\\left|\\right/g, ''],
]

export function normalizeMath(input: string): string {
  let text = recoverEatenCommands(input)

  for (let pass = 0; pass < 2; pass++) {
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

export function roundLines(lines: TextLine[] | null): TextLine[] {
  const rounded: TextLine[] = []
  if (!lines) return rounded

  for (const line of lines) {
    const bbox: BBox = [
      Math.round(line.bbox[0]), Math.round(line.bbox[1]), Math.round(line.bbox[2]),
      Math.round(line.bbox[3]),
    ]

    rounded.push({ text: line.text, bbox })
  }

  return rounded
}

const QUESTION_START = /^[ \t]*\(?(\d{1,3})[.)]?[ \t]+(?=[A-Z(])(.{12,})$/gm
const PROSE = /[a-z]{3,}/g

function looksLikeQuestion(line: string): boolean {
  const words = line.match(PROSE)
  if (!words) return false

  return words.length >= 3
}

export type QuestionStart = {
  number: number
  at: number
  bodyFrom: number
}

function questionStartsOn(text: string): QuestionStart[] {
  QUESTION_START.lastIndex = 0

  const starts: QuestionStart[] = []
  for (let match = QUESTION_START.exec(text); match; match = QUESTION_START.exec(text)) {
    if (!looksLikeQuestion(match[2])) continue
    starts.push({
      number: Number(match[1]),
      at: match.index,
      bodyFrom: match.index + match[0].length - match[2].length,
    })
  }

  return starts
}

export function firstQuestionAt(text: string): number {
  const starts = questionStartsOn(text)
  if (starts.length === 0) return text.length

  return starts[0].at
}

export function countQuestionStarts(text: string): number {
  return questionStartsOn(text).length
}

const SEAM_CHARS = 1200

function tailOf(text: string): string {
  if (text.length <= SEAM_CHARS) return text.trim()

  const cut = text.slice(text.length - SEAM_CHARS)
  const firstBreak = cut.indexOf('\n')

  if (firstBreak === -1) return cut.trim()

  return cut.slice(firstBreak + 1).trim()
}

function headOf(text: string): string {
  if (text.length <= SEAM_CHARS) return text.trim()

  const cut = text.slice(0, SEAM_CHARS)
  const lastBreak = cut.lastIndexOf('\n')

  if (lastBreak === -1) return cut.trim()

  return cut.slice(0, lastBreak).trim()
}

function ocrTextAt(
  pages: readonly { ocrText?: string | null }[],
  index: number,
): string {
  const page = pages[index]
  if (!page || !page.ocrText) return ''

  return page.ocrText
}

export function seamAround(
  pages: readonly { ocrText?: string | null }[],
  index: number,
): { before: string; after: string } {
  return {
    before: tailOf(ocrTextAt(pages, index - 1)),
    after: headOf(ocrTextAt(pages, index + 1)),
  }
}

export type PagePosition = {
  printedNumber: number | null
  top: number | null
  position: number
}

export function sortWithinPage<T extends PagePosition>(page: T[]): T[] {
  let numbered = true
  let geometric = true

  for (const question of page) {
    if (question.printedNumber === null) numbered = false
    if (question.top === null) geometric = false
  }

  function key(question: T): number {
    if (numbered) return question.printedNumber as number
    if (geometric) return question.top as number

    return question.position
  }

  const ordered = page.slice()

  ordered.sort(function (a, b) {
    const left = key(a)
    const right = key(b)

    if (left !== right) return left - right

    return a.position - b.position
  })

  return ordered
}

const ITEM_START = /^(?:[-•*·–—]\s|\(?(?:[IVX]{1,4}|[A-H]|\d{1,2})[).]\s)/

function joinParagraph(paragraph: string): string {
  let joined = ''

  for (const raw of paragraph.split('\n')) {
    const line = raw.trim()
    if (!line) continue

    if (!joined) {
      joined = line
      continue
    }

    if (ITEM_START.test(line)) {
      joined = joined + '\n' + line
      continue
    }

    if (/[a-z]-$/.test(joined) && /^[a-z]/.test(line)) {
      joined = joined.slice(0, -1) + line
      continue
    }

    joined = joined + ' ' + line
  }

  return joined
}

export function reflowText(input: string): string {
  const paragraphs = input.replace(/\r\n?/g, '\n').split(/\n{2,}/)

  const kept: string[] = []

  for (const paragraph of paragraphs) {
    const joined = joinParagraph(paragraph)
    if (joined) kept.push(joined)
  }

  return kept.join('\n\n').trim()
}

export type QuestionEvidence = {
  src: string
  width: number
  height: number
  bbox: BBox
}

export type EvidencePage = {
  imageKey: string
  width: number | null
  height: number | null
}

export function evidenceFor(
  bbox: BBox | null,
  page: EvidencePage | undefined,
): QuestionEvidence | null {
  if (!bbox || !page || !page.width || !page.height) return null

  const x0 = bbox[0]
  const y0 = bbox[1]
  const x1 = bbox[2]
  const y1 = bbox[3]

  if (x1 <= x0 || y1 <= y0) return null
  if (x0 >= page.width || y0 >= page.height || x1 <= 0 || y1 <= 0) return null

  return {
    src: '/api/files/' + page.imageKey,
    width: page.width,
    height: page.height,
    bbox,
  }
}

const LABEL = '[A-Ea-e]'

const SOLUTION_LINE = new RegExp('(?:^|\\s)(\\d{1,3})[.)]\\s*Answer:?\\s*\\(?(' + LABEL + ')\\)?', 'g')

const GRID_LINE = new RegExp('^(?:\\d{1,3}[.)]\\s*\\(?' + LABEL + '\\)?[\\s,;]*)+$')
const GRID_PAIR = new RegExp('(\\d{1,3})[.)]\\s*\\(?(' + LABEL + ')\\)?', 'g')

const MIN_ENTRIES = 3

function stripTags(text: string): string {
  return text.replace(/<\/?[a-z][a-z0-9]{0,7}\s*\/?>/gi, '')
}

export function parseAnswerKey(pageText: string): Map<number, string> {
  const text = stripTags(pageText)
  if (text.trim().length === 0) return new Map()

  const seen = new Map<number, Set<string>>()

  function record(number: number, label: string) {
    if (number < 1) return

    let set = seen.get(number)

    if (!set) {
      set = new Set<string>()
      seen.set(number, set)
    }

    set.add(label.toUpperCase())
  }

  SOLUTION_LINE.lastIndex = 0
  for (let match = SOLUTION_LINE.exec(text); match; match = SOLUTION_LINE.exec(text)) {
    record(Number(match[1]), match[2])
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0 || !GRID_LINE.test(line)) continue

    GRID_PAIR.lastIndex = 0
    for (let match = GRID_PAIR.exec(line); match; match = GRID_PAIR.exec(line)) {
      record(Number(match[1]), match[2])
    }
  }

  const key = new Map<number, string>()

  for (const [number, labels] of seen) {
    if (labels.size !== 1) continue

    for (const label of labels) key.set(number, label)
  }

  if (key.size < MIN_ENTRIES) return new Map()

  return key
}

const KEY_HEADING =
  /^[ \t]*(?:answers?[ \t]*key|complete[ \t]+solutions?|solutions?|answers?[ \t]+and[ \t]+(?:explanations?|solutions?))[ \t]*:?[ \t]*$/im

function statesAnswers(text: string): boolean {
  if (KEY_HEADING.test(text)) return true

  SOLUTION_LINE.lastIndex = 0
  if (SOLUTION_LINE.exec(text)) return true

  for (const line of text.split(/\r?\n/)) {
    if (GRID_LINE.test(line.trim())) return true
  }

  return false
}

export function isAnswerPage(pageText: string): boolean {
  const text = stripTags(pageText)
  if (text.trim().length === 0) return false

  if (countQuestionStarts(text) > 0) return false

  return statesAnswers(text)
}

export function mergeAnswerKeys(keys: Map<number, string>[]): Map<number, string> {
  const seen = new Map<number, Set<string>>()

  for (const key of keys) {
    for (const [number, label] of key) {
      let set = seen.get(number)

      if (!set) {
        set = new Set<string>()
        seen.set(number, set)
      }

      set.add(label)
    }
  }

  const merged = new Map<number, string>()

  for (const [number, labels] of seen) {
    if (labels.size !== 1) continue

    for (const label of labels) merged.set(number, label)
  }

  return merged
}
