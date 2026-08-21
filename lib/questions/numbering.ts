import { firstQuestionAt } from './text'
import { normalizeForCompare, normalizeMath } from './shape'

export interface PageOption {
  label: string
  text: string
}

export interface PageQuestion {
  number: number
  stem: string
  options: PageOption[]
}

const NUMBERED_LINE = /^[ \t]*\(?(\d{1,3})[.)][ \t]+(.*)$/gm
const OPTION_LINE = /^[ \t]*\(?([A-Za-z])[).][ \t]+(.*)$/gm
const MAX_OPTION_TEXT = 300

const A = 'A'.charCodeAt(0)

function nextLabelInside(body: string, code: number): boolean {
  if (code > 'Z'.charCodeAt(0)) return false

  const label = String.fromCharCode(code)
  return new RegExp(`(?<![\\p{L}\\p{N}])\\(?[${label}${label.toLowerCase()}][).][ \\t]`, 'u').test(
    body,
  )
}

export function questionsOnPage(pageText: string): PageQuestion[] {
  const text = pageText ?? ''

  const starts: { number: number; at: number; bodyFrom: number }[] = []
  NUMBERED_LINE.lastIndex = 0

  for (let match = NUMBERED_LINE.exec(text); match; match = NUMBERED_LINE.exec(text)) {
    starts.push({
      number: Number(match[1]),
      at: match.index,
      bodyFrom: match.index + match[0].length - match[2].length,
    })
  }

  return starts.map((start, index) => {
    const block = text.slice(start.bodyFrom, starts[index + 1]?.at ?? text.length)

    const marks: { label: string; at: number; textFrom: number }[] = []
    OPTION_LINE.lastIndex = 0

    for (let match = OPTION_LINE.exec(block); match; match = OPTION_LINE.exec(block)) {
      marks.push({
        label: match[1].toUpperCase(),
        at: match.index,
        textFrom: match.index + match[0].length - match[2].length,
      })
    }

    let options: PageOption[] = []
    for (const [position, mark] of marks.entries()) {
      if (mark.label.charCodeAt(0) !== A + position) break

      const endsAt = marks[position + 1]?.at ?? block.length
      const body = block.slice(mark.textFrom, endsAt).trim()

      if (body.length === 0 || body.length > MAX_OPTION_TEXT) break

      if (nextLabelInside(body, A + position + 1)) {
        options = []
        break
      }

      options.push({ label: mark.label, text: normalizeMath(body) })
    }

    const stemEnd = marks[0]?.at ?? block.length

    return {
      number: start.number,
      stem: normalizeMath(block.slice(0, stemEnd).trim()),
      options,
    }
  })
}

const MIN_MATCH = 24
const COMPARE = 40

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function sameOpening(a: string, b: string): boolean {
  const left = a.slice(0, COMPARE)
  const right = b.slice(0, COMPARE)
  if (left.length < MIN_MATCH || right.length < MIN_MATCH) return false
  return left.startsWith(right) || right.startsWith(left)
}

export function printedNumbersFor(
  pageText: string,
  prompts: readonly string[],
): (number | null)[] {
  const stems = questionsOnPage(pageText ?? '').map((question) => ({
    number: question.number,
    head: normalize(question.stem),
  }))

  if (stems.length === 0) return prompts.map(() => null)

  const taken = new Set<number>()

  return prompts.map((prompt) => {
    const head = normalize(prompt ?? '')

    const hit = stems.find((stem) => !taken.has(stem.number) && sameOpening(stem.head, head))
    if (!hit) return null

    taken.add(hit.number)
    return hit.number
  })
}

export interface NumberedQuestion {
  id: string
  pageNumber: number | null
  position: number
  printedNumber: number | null
}

export interface NumberFix {
  id: string
  from: number | null
  to: number
  reason: 'filled-blank' | 'corrected-stray'
}

function inOrder(items: NumberedQuestion[]): NumberedQuestion[] {
  return [...items].sort((a, b) => {
    const pageA = a.pageNumber ?? Number.MAX_SAFE_INTEGER
    const pageB = b.pageNumber ?? Number.MAX_SAFE_INTEGER
    if (pageA !== pageB) return pageA - pageB
    return a.position - b.position
  })
}

function trustedNumbers(ordered: NumberedQuestion[]): Map<string, number> {
  const seen = new Map<number, number>()
  for (const item of ordered) {
    if (item.printedNumber !== null) {
      seen.set(item.printedNumber, (seen.get(item.printedNumber) ?? 0) + 1)
    }
  }

  const unique = ordered.filter(
    (item) => item.printedNumber !== null && seen.get(item.printedNumber) === 1,
  )

  const best: number[] = []
  const from: number[] = new Array(unique.length).fill(-1)
  const length: number[] = new Array(unique.length).fill(1)

  for (let i = 0; i < unique.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      const rising = (unique[j].printedNumber as number) < (unique[i].printedNumber as number)
      if (rising && length[j] + 1 > length[i]) {
        length[i] = length[j] + 1
        from[i] = j
      }
    }
  }

  let end = length.indexOf(Math.max(...length, 0))
  while (end >= 0) {
    best.unshift(end)
    end = from[end]
  }

  const trusted = new Map<string, number>()
  for (const index of best) {
    const item = unique[index]
    trusted.set(item.id, item.printedNumber as number)
  }
  return trusted
}

export function inferPrintedNumbers(
  items: NumberedQuestion[],
  expectedTotal: number | null,
): NumberFix[] {
  if (items.length === 0) return []

  const ordered = inOrder(items)
  const trusted = trustedNumbers(ordered)
  if (trusted.size === 0) return []

  const ceiling = expectedTotal && expectedTotal > 0
    ? expectedTotal
    : Math.max(...trusted.values())

  const taken = new Set(trusted.values())
  const available: number[] = []
  for (let n = 1; n <= ceiling; n += 1) if (!taken.has(n)) available.push(n)
  if (available.length === 0) return []

  const fixes: NumberFix[] = []

  let index = 0
  while (index < ordered.length) {
    if (trusted.has(ordered[index].id)) {
      index += 1
      continue
    }

    let end = index
    while (end < ordered.length && !trusted.has(ordered[end].id)) end += 1

    const run = ordered.slice(index, end)

    let low = 0
    for (let back = index - 1; back >= 0; back -= 1) {
      const anchor = trusted.get(ordered[back].id)
      if (anchor !== undefined) { low = anchor; break }
    }

    let high = ceiling + 1
    for (let forward = end; forward < ordered.length; forward += 1) {
      const anchor = trusted.get(ordered[forward].id)
      if (anchor !== undefined) { high = anchor; break }
    }

    const candidates = available.filter((n) => n > low && n < high)

    if (candidates.length === run.length) {
      for (const [offset, item] of run.entries()) {
        const to = candidates[offset]
        if (item.printedNumber === to) continue
        fixes.push({
          id: item.id,
          from: item.printedNumber,
          to,
          reason: item.printedNumber === null ? 'filled-blank' : 'corrected-stray',
        })
      }
    }

    index = end
  }

  return fixes
}
export interface DuplicateCandidate {
  id: string
  printedNumber: number | null
  promptText: string
  choices: { label: string; text: string }[]
}

export interface MergePlan {
  keepId: string
  dropId: string
  printedNumber: number | null
}

function isAlphabetic(label: string): boolean {
  return /^[a-z]$/i.test(label.trim())
}

function isNumeric(label: string): boolean {
  return /^\d+$/.test(label.trim())
}

function labelStyle(choices: { label: string }[]): 'alpha' | 'numeric' | 'mixed' {
  if (choices.length === 0) return 'mixed'
  if (choices.every((c) => isAlphabetic(c.label))) return 'alpha'
  if (choices.every((c) => isNumeric(c.label))) return 'numeric'
  return 'mixed'
}

function choicesAreContainedIn(
  inner: { text: string }[],
  outer: { text: string }[],
): boolean {
  if (inner.length === 0 || outer.length === 0) return false

  const haystacks = outer.map((c) => normalizeForCompare(c.text)).filter(Boolean)
  if (haystacks.length === 0) return false

  return inner.every((choice) => {
    const needle = normalizeForCompare(choice.text)
    if (needle.length < 12) return false
    return haystacks.some((hay) => hay.includes(needle))
  })
}

export function planDuplicateMerges(questions: DuplicateCandidate[]): MergePlan[] {
  const byPrompt = new Map<string, DuplicateCandidate[]>()

  for (const question of questions) {
    const key = normalizeForCompare(question.promptText)
    if (!key) continue
    byPrompt.set(key, [...(byPrompt.get(key) ?? []), question])
  }

  const plans: MergePlan[] = []

  for (const group of byPrompt.values()) {
    if (group.length !== 2) continue

    const [a, b] = group
    const styleA = labelStyle(a.choices)
    const styleB = labelStyle(b.choices)

    let real: DuplicateCandidate
    let phantom: DuplicateCandidate

    if (styleA === 'alpha' && styleB === 'numeric') {
      real = a
      phantom = b
    } else if (styleB === 'alpha' && styleA === 'numeric') {
      real = b
      phantom = a
    } else {
      continue
    }

    if (!choicesAreContainedIn(phantom.choices, real.choices)) continue

    const numbers = [real.printedNumber, phantom.printedNumber].filter(
      (n): n is number => typeof n === 'number',
    )

    plans.push({
      keepId: real.id,
      dropId: phantom.id,
      printedNumber: numbers.length > 0 ? Math.min(...numbers) : null,
    })
  }

  return plans
}

export function duplicatePrintedNumbers(
  questions: { printedNumber: number | null }[],
): number[] {
  const counts = new Map<number, number>()

  for (const question of questions) {
    if (typeof question.printedNumber !== 'number') continue
    counts.set(question.printedNumber, (counts.get(question.printedNumber) ?? 0) + 1)
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([number]) => number)
    .sort((a, b) => a - b)
}

export function promptSimilarity(left: string, right: string): number {
  const a = new Set(normalizeForCompare(left).split(' ').filter(Boolean))
  const b = new Set(normalizeForCompare(right).split(' ').filter(Boolean))

  if (a.size === 0 || b.size === 0) return 0

  let shared = 0
  for (const word of a) if (b.has(word)) shared += 1

  return shared / (a.size + b.size - shared)
}

const SAME_QUESTION_SIMILARITY = 0.8

function damage(question: DuplicateCandidate, expectedChoices: number): number {
  const text = question.promptText
  let score = 0

  score += (text.match(/(?:^|\s)_(?:\s|$)/g) ?? []).length * 3
  score += (text.match(/_\s*\d/g) ?? []).length * 2
  if (question.choices.length !== expectedChoices) score += 4
  if (text.trim().length < 25) score += 5

  return score
}

function wordSet(text: string): Set<string> {
  return new Set(normalizeForCompare(text).split(' ').filter(Boolean))
}

function truncationPair(
  a: DuplicateCandidate,
  b: DuplicateCandidate,
): { keep: DuplicateCandidate; drop: DuplicateCandidate } | null {
  const pair = (short: DuplicateCandidate, long: DuplicateCandidate) => {
    if (short.choices.length > 0 || long.choices.length === 0) return null
    if (short.promptText.length >= long.promptText.length) return null

    const words = wordSet(short.promptText)
    if (words.size === 0) return null

    const inLong = wordSet(long.promptText)
    for (const word of words) if (!inLong.has(word)) return null

    return { keep: long, drop: short }
  }

  return pair(a, b) ?? pair(b, a)
}

export function planNumberDuplicateMerges(
  questions: DuplicateCandidate[],
  expectedChoices: number,
): MergePlan[] {
  const byNumber = new Map<number, DuplicateCandidate[]>()

  for (const question of questions) {
    if (question.printedNumber === null) continue
    byNumber.set(question.printedNumber, [
      ...(byNumber.get(question.printedNumber) ?? []),
      question,
    ])
  }

  const plans: MergePlan[] = []

  for (const [printedNumber, group] of byNumber) {
    if (group.length !== 2) continue

    const [a, b] = group

    const cut = truncationPair(a, b)
    if (cut) {
      plans.push({ keepId: cut.keep.id, dropId: cut.drop.id, printedNumber })
      continue
    }

    if (promptSimilarity(a.promptText, b.promptText) < SAME_QUESTION_SIMILARITY) continue

    const keep = damage(a, expectedChoices) <= damage(b, expectedChoices) ? a : b
    const drop = keep === a ? b : a

    plans.push({ keepId: keep.id, dropId: drop.id, printedNumber })
  }

  return plans
}

export interface CarriedChoice {
  label: string
  text: string
}

const OPTION = /(?<![\p{L}\p{N}])\(?([A-Za-z])[).][ \t]+/gu



function heldLabels(raw: string[]): string[] {
  const letters = raw
    .map((label) => label.trim().toUpperCase())
    .filter((label) => /^[A-Z]$/.test(label))

  return [...new Set(letters)].sort()
}

export interface CarriedChoiceOptions {
  
  expectedCount?: number | null
  
  held?: string[]
}

export function parseCarriedChoices(
  pageText: string,
  options: CarriedChoiceOptions = {},
): CarriedChoice[] | null {
  const text = pageText ?? ''
  if (text.trim().length === 0) return null

  const expected = options.expectedCount ?? null
  const held = heldLabels(options.held ?? [])

  let startCode = A
  let need: number | null = expected

  if (held.length > 0) {
    
    
    
    if (!held.every((label, index) => label.charCodeAt(0) === A + index)) return null
    
    
    if (expected === null || held.length >= expected) return null

    startCode = A + held.length
    need = expected - held.length
  }

  const limit = firstQuestionAt(text)
  
  
  const head = text.slice(0, limit)
  if (head.trim().length === 0) return null

  const marks: { label: string; at: number; textFrom: number }[] = []
  OPTION.lastIndex = 0

  for (let match = OPTION.exec(head); match; match = OPTION.exec(head)) {
    marks.push({
      label: match[1].toUpperCase(),
      at: match.index,
      textFrom: match.index + match[0].length,
    })
  }

  
  
  
  
  const minimum = held.length > 0 ? need! : 3
  if (marks.length < minimum) return null

  const start = marks.findIndex((mark) => mark.label.charCodeAt(0) === startCode)
  if (start === -1) return null

  
  
  
  if (held.length > 0 && start !== 0) return null

  const run: CarriedChoice[] = []
  let expectedCode = startCode

  for (let index = start; index < marks.length; index += 1) {
    const mark = marks[index]
    if (mark.label.charCodeAt(0) !== expectedCode) break

    const endsAt = marks[index + 1]?.at ?? head.length
    const body = head.slice(mark.textFrom, endsAt).trim()

    
    
    if (body.length === 0 || body.length > MAX_OPTION_TEXT) break

    run.push({ label: mark.label, text: normalizeMath(body) })
    expectedCode += 1
  }

  if (run.length < minimum) return null

  
  
  
  if (need !== null && run.length !== need) return null

  return run
}
