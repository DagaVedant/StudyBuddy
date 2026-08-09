/**
 * The number a page prints a question under, taken from the page rather than
 * from the model.
 *
 * Extraction returns an `ordinal` per question and ingest stored it as the
 * printed number verbatim. That holds while a page is read as part of the whole
 * paper and breaks the moment one is read on its own: the audit re-reads a page
 * to recover the questions it is missing, the model numbers what it can see
 * from 1, and those numbers are stored over the real ones. Re-reading page 2 of
 * `topic_test3_20` for its missing 9-16 filed them as 1-7, on top of page 1's
 * real 1-7, so the sheet came out of a repair holding seven duplicate numbers
 * and still missing seven questions.
 *
 * The page already says what it prints. `questionsOnPage` reads "9. <stem>"
 * out of the text layer, so a question can be matched back to the stem it came
 * from and given that stem's number, with no model call and nothing inferred.
 */
import { questionsOnPage } from './page-options'

/** Below this a prompt is too short to identify a stem safely. */
const MIN_MATCH = 24

/** How much of the two strings has to agree. */
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

/**
 * For each prompt, the number the page prints it under, or null.
 *
 * Null rather than a guess: a caller that cannot be told keeps whatever it had,
 * and a wrong number is worse than the model's, because it silently claims to
 * be the paper's own.
 *
 * A page number is handed out at most once. Two prompts that open identically
 * are two rows of one question far more often than they are two questions, and
 * giving both the same number would rebuild the collision this exists to stop.
 */
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
