import { normalizeForCompare } from './shape'

export interface DuplicateCandidate {
  id: string
  printedNumber: number | null
  promptText: string
  choices: { label: string; text: string }[]
}

export interface MergePlan {
  /** The row that survives. */
  keepId: string
  /** The row that gets deleted. */
  dropId: string
  /**
   * Number the surviving row should end up with.
   *
   * The phantom is built from material printed above the real question, so it
   * takes the lower number and pushes the real one up by one — which then
   * collides with the next question along. Handing the lower number back
   * repairs the whole run, not just the count.
   */
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

/**
 * True when every one of `inner`'s choices turns up inside one of `outer`'s.
 *
 * This is the check that separates a phantom from a real question. When the
 * model reads a list of numbered source sentences as though it were an answer
 * list, each of those sentences also appears verbatim inside the real
 * question's options, because the real options are combinations of them. Two
 * genuinely different questions that happen to share a stem will not have
 * that relationship.
 */
function choicesAreContainedIn(
  inner: { text: string }[],
  outer: { text: string }[],
): boolean {
  if (inner.length === 0 || outer.length === 0) return false

  const haystacks = outer.map((c) => normalizeForCompare(c.text)).filter(Boolean)
  if (haystacks.length === 0) return false

  return inner.every((choice) => {
    const needle = normalizeForCompare(choice.text)
    // Something trivially short would match almost anything.
    if (needle.length < 12) return false
    return haystacks.some((hay) => hay.includes(needle))
  })
}

/**
 * Finds questions the extractor produced twice from a single one on the page.
 *
 * Deliberately narrow. It only acts on a pair sharing an identical prompt
 * where one side is plainly the raw material of the other, because the cost of
 * being wrong is asymmetric: an extra question is visible in review and easy
 * to delete, while a wrongly merged pair silently destroys a real question and
 * nothing downstream will ever flag it.
 */
export function planDuplicateMerges(questions: DuplicateCandidate[]): MergePlan[] {
  const byPrompt = new Map<string, DuplicateCandidate[]>()

  for (const question of questions) {
    const key = normalizeForCompare(question.promptText)
    if (!key) continue
    byPrompt.set(key, [...(byPrompt.get(key) ?? []), question])
  }

  const plans: MergePlan[] = []

  for (const group of byPrompt.values()) {
    // Three or more sharing a prompt is not the shape this handles, and
    // guessing at it risks exactly the silent loss described above.
    if (group.length !== 2) continue

    const [a, b] = group
    const styleA = labelStyle(a.choices)
    const styleB = labelStyle(b.choices)

    // One side has to look like an answer list and the other like the raw
    // material it was drawn from.
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

/** Printed numbers used by more than one question in the same worksheet. */
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
