import { normalizeForCompare } from './shape'

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
