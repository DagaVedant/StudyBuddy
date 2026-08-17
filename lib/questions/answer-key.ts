import { countQuestionStarts } from './page-text'

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
