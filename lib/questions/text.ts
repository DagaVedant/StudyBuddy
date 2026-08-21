import { type BBox, type TextLine } from '@/lib/db/schema'

export function roundLines(lines: TextLine[] | null): TextLine[] {
  return (lines ?? []).map((line) => {
    const bbox: BBox = [
      Math.round(line.bbox[0]),
      Math.round(line.bbox[1]),
      Math.round(line.bbox[2]),
      Math.round(line.bbox[3]),
    ]
    return { text: line.text, bbox }
  })
}

const QUESTION_START = /^[ \t]*\(?(\d{1,3})[.)]?[ \t]+(?=[A-Z(])(.{12,})$/gm
const PROSE = /[a-z]{3,}/g

function looksLikeQuestion(line: string): boolean {
  return (line.match(PROSE) ?? []).length >= 3
}

export interface QuestionStart {
  
  number: number
  
  at: number
  
  bodyFrom: number
}

export function questionStartsOn(text: string): QuestionStart[] {
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
  return questionStartsOn(text)[0]?.at ?? text.length
}

export function questionNumbersOn(text: string): number[] {
  return questionStartsOn(text).map((start) => start.number)
}

export function countQuestionStarts(text: string): number {
  return questionNumbersOn(text).length
}

const SEAM_CHARS = 1200

export function tailOf(text: string, limit = SEAM_CHARS): string {
  if (text.length <= limit) return text.trim()

  const cut = text.slice(text.length - limit)
  const firstBreak = cut.indexOf('\n')
  return (firstBreak === -1 ? cut : cut.slice(firstBreak + 1)).trim()
}

export function headOf(text: string, limit = SEAM_CHARS): string {
  if (text.length <= limit) return text.trim()

  const cut = text.slice(0, limit)
  const lastBreak = cut.lastIndexOf('\n')
  return (lastBreak === -1 ? cut : cut.slice(0, lastBreak)).trim()
}

export function seamAround(
  pages: readonly { ocrText?: string | null }[],
  index: number,
): { before: string; after: string } {
  return {
    before: tailOf(pages[index - 1]?.ocrText ?? ''),
    after: headOf(pages[index + 1]?.ocrText ?? ''),
  }
}

export interface PagePosition {
  printedNumber: number | null
  
  top: number | null
  
  position: number
}

export function sortWithinPage<T extends PagePosition>(page: T[]): T[] {
  const numbered = page.every((question) => question.printedNumber !== null)
  const geometric = page.every((question) => question.top !== null)

  const key = (question: T): number =>
    numbered
      ? (question.printedNumber as number)
      : geometric
        ? (question.top as number)
        : question.position

  
  
  return [...page].sort((a, b) => key(a) - key(b) || a.position - b.position)
}

const ITEM_START = /^(?:[-•*·–—]\s|\(?(?:[IVX]{1,4}|[A-H]|\d{1,2})[).]\s)/

export function reflowText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((paragraph) => {
      const lines = paragraph
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)

      return lines.reduce((joined, line) => {
        if (!joined) return line
        if (ITEM_START.test(line)) return `${joined}\n${line}`
        if (/[a-z]-$/.test(joined) && /^[a-z]/.test(line)) {
          return `${joined.slice(0, -1)}${line}`
        }
        return `${joined} ${line}`
      }, '')
    })
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

export interface QuestionEvidence {
  src: string
  width: number
  height: number
  bbox: BBox
}

export interface EvidencePage {
  imageKey: string
  width: number | null
  height: number | null
}

export function evidenceFor(
  bbox: BBox | null,
  page: EvidencePage | undefined,
): QuestionEvidence | null {
  if (!bbox || !page?.width || !page.height) return null

  const [x0, y0, x1, y1] = bbox
  if (x1 <= x0 || y1 <= y0) return null
  if (x0 >= page.width || y0 >= page.height || x1 <= 0 || y1 <= 0) return null

  return {
    src: `/api/files/${page.imageKey}`,
    width: page.width,
    height: page.height,
    bbox,
  }
}
const LABEL = '[A-Ea-e]'

const SOLUTION_LINE = new RegExp(`(?:^|\\s)(\\d{1,3})[.)]\\s*Answer:?\\s*\\(?(${LABEL})\\)?`, 'g')

const GRID_LINE = new RegExp(`^(?:\\d{1,3}[.)]\\s*\\(?${LABEL}\\)?[\\s,;]*)+$`)
const GRID_PAIR = new RegExp(`(\\d{1,3})[.)]\\s*\\(?(${LABEL})\\)?`, 'g')

const MIN_ENTRIES = 3

function stripTags(text: string): string {
  return text.replace(/<\/?[a-z][a-z0-9]{0,7}\s*\/?>/gi, '')
}

export function parseAnswerKey(pageText: string): Map<number, string> {
  const text = stripTags(pageText ?? '')
  if (text.trim().length === 0) return new Map()

  const seen = new Map<number, Set<string>>()

  const record = (number: number, label: string) => {
    if (number < 1) return
    const set = seen.get(number) ?? new Set<string>()
    set.add(label.toUpperCase())
    seen.set(number, set)
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
    key.set(number, [...labels][0])
  }

  return key.size >= MIN_ENTRIES ? key : new Map()
}

const KEY_HEADING =
  /^[ \t]*(?:answers?[ \t]*key|complete[ \t]+solutions?|solutions?|answers?[ \t]+and[ \t]+(?:explanations?|solutions?))[ \t]*:?[ \t]*$/im

function statesAnswers(text: string): boolean {
  if (KEY_HEADING.test(text)) return true

  SOLUTION_LINE.lastIndex = 0
  if (SOLUTION_LINE.exec(text)) return true

  return text.split(/\r?\n/).some((line) => GRID_LINE.test(line.trim()))
}

export function isAnswerPage(pageText: string): boolean {
  const text = stripTags(pageText ?? '')
  if (text.trim().length === 0) return false

  if (countQuestionStarts(text) > 0) return false

  return statesAnswers(text)
}

export function mergeAnswerKeys(keys: Map<number, string>[]): Map<number, string> {
  const seen = new Map<number, Set<string>>()

  for (const key of keys) {
    for (const [number, label] of key) {
      const set = seen.get(number) ?? new Set<string>()
      set.add(label)
      seen.set(number, set)
    }
  }

  const merged = new Map<number, string>()
  for (const [number, labels] of seen) {
    if (labels.size === 1) merged.set(number, [...labels][0])
  }

  return merged
}
