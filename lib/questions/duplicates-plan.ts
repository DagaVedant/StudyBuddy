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
   * takes the lower number and pushes the real one up by one, which then
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

/**
 * How alike two prompts are, as the share of words they hold in common.
 *
 * Word sets rather than character distance, because the difference between two
 * reads of one question is usually a mangled symbol or a dropped fragment,
 * which barely moves the vocabulary. Two different questions off the same paper
 * move it a lot even when they are phrased alike.
 */
export function promptSimilarity(left: string, right: string): number {
  const a = new Set(normalizeForCompare(left).split(' ').filter(Boolean))
  const b = new Set(normalizeForCompare(right).split(' ').filter(Boolean))

  if (a.size === 0 || b.size === 0) return 0

  let shared = 0
  for (const word of a) if (b.has(word)) shared += 1

  return shared / (a.size + b.size - shared)
}

/**
 * How alike two prompts must be before one of them may be deleted.
 *
 * Set high on purpose. Two consecutive questions on a maths paper share most of
 * their scaffolding: "what value of x satisfies 3x - 7 = 20" against "what
 * value of x satisfies 5(x - 3) = 2x + 9" already scores about 0.42, so
 * anything permissive here deletes real questions. A genuine second read of one
 * question differs by a symbol or two and scores well above this.
 */
const SAME_QUESTION_SIMILARITY = 0.8

/**
 * How damaged a transcription looks, lower being better.
 *
 * Used only to choose between two rows that are already known to be the same
 * question. The markers are the ones real re-reads produced: a bare underscore
 * where a fraction bar was, a digit stranded from its denominator, and a
 * shorter body that stopped early.
 */
function damage(question: DuplicateCandidate, expectedChoices: number): number {
  const text = question.promptText
  let score = 0

  score += (text.match(/(?:^|\s)_(?:\s|$)/g) ?? []).length * 3
  score += (text.match(/_\s*\d/g) ?? []).length * 2
  if (question.choices.length !== expectedChoices) score += 4
  if (text.trim().length < 25) score += 5

  return score
}

/**
 * Folds two rows that claim the same printed number.
 *
 * A number appears once on a real paper, so two rows carrying the same one are
 * the same question stored twice. This is the shape the review pass produced
 * before it stopped re-saving whole pages: the same question read a second
 * time, transcribed slightly differently, and therefore hashed differently.
 *
 * Separate from the prompt-based rule above, which cannot see these because
 * the two texts do not match. Kept narrow in the same way: pairs only, and the
 * survivor is whichever transcription is less damaged rather than whichever
 * arrived first, because the better copy was sometimes the later one.
 *
 * The number alone is never enough. A page whose printed numbers the extractor
 * failed to read comes back numbered 1..n by position, and those collide with
 * the real 1..n of the page before it: six collisions on one Edison sheet,
 * six real questions deleted, and every count-based check reporting success
 * afterwards because the totals still added up. So the texts have to agree as
 * well: a number held by two questions that read differently means one of them
 * is misnumbered, and misnumbering is repaired by renumbering, never by
 * deleting.
 *
 * Prompt similarity, and deliberately not the `choicesAreContainedIn` check the
 * rule above uses. That check needs a match of twelve characters or more, which
 * is correct where it is used, because there the options are whole source
 * sentences. The options here are "4", "6", "9", "12". Every one is under the
 * floor, so containment can never fire on a maths paper and requiring it would
 * mean never folding a re-read at all. Measured, not assumed: see
 * "folds the re-read that a containment check would have missed" in
 * tests/unit/duplicates.test.ts.
 */
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
    if (promptSimilarity(a.promptText, b.promptText) < SAME_QUESTION_SIMILARITY) continue

    const keep = damage(a, expectedChoices) <= damage(b, expectedChoices) ? a : b
    const drop = keep === a ? b : a

    plans.push({ keepId: keep.id, dropId: drop.id, printedNumber })
  }

  return plans
}
