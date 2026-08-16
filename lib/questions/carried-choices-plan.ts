/**
 * Reads the answer options a page break carried onto the next page.
 *
 * The join in split-pages.ts repairs a split only when the extractor returned
 * both halves. Often it returns one: a bare block of options with no question
 * above it is not a question, so the model drops it, and the stem at the foot
 * of the previous page keeps no record that its answers ever existed. On the
 * AMC8 2024 paper that is four of the five splits: questions 5, 14, 18 and 23
 * each lost every option they had, and no second row was ever written to join.
 *
 * The options are still on the page, in the text layer, above the first
 * question printed there. Reading them from the text costs nothing, needs no
 * model, and does not depend on the extractor having noticed them.
 */
import { normalizeMath } from './math'
import { firstQuestionAt } from './page-text'

export interface CarriedChoice {
  label: string
  text: string
}

/**
 * A labelled option: "(A) 28", "A. 28", "(a) 28".
 *
 * The lookbehind keeps it from firing inside a word or a number, which is what
 * separates a real option list from the middle of a sentence.
 */
const OPTION = /(?<![\p{L}\p{N}])\(?([A-Za-z])[).][ \t]+/gu

/** Longest an option's text may run before it stops looking like an option. */
const MAX_OPTION_TEXT = 300

const A = 'A'.charCodeAt(0)

/** The labels a question already holds, cleaned up and de-duplicated. */
function heldLabels(raw: string[]): string[] {
  const letters = raw
    .map((label) => label.trim().toUpperCase())
    .filter((label) => /^[A-Z]$/.test(label))

  return [...new Set(letters)].sort()
}

export interface CarriedChoiceOptions {
  /** How many options this paper gives a question, if it is consistent. */
  expectedCount?: number | null
  /**
   * Labels the question at the foot of the previous page kept.
   *
   * Empty for the shape this was first written for, where the stem carried
   * nothing at all. When the page break falls *inside* the option list the
   * stem keeps `A` and sometimes `A, B`, and the run to look for here starts
   * at the label after the last one it kept rather than at A.
   */
  held?: string[]
}

/**
 * Pulls the options a question left behind on the page after it.
 *
 * Returns null unless the page opens with one complete, consecutive run of
 * options printed above everything else on it. Anything less is left alone:
 * these options are about to be handed to a question that is missing some, and
 * handing it the wrong ones is worse than leaving it visibly incomplete for
 * the student to fix.
 *
 * Where the run has to start depends on what the question kept. A stem that
 * kept nothing wants a full list beginning at A. A stem that kept `A` wants
 * exactly `B, C, D`. The original refused that, on the grounds that a run not
 * starting at A is "the tail of a list whose head is on some other page",
 * which is precisely the case this function exists for: the head is on the
 * previous page, attached to a stem holding one option. Thirteen questions in
 * the Edison run are that shape.
 */
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
    // Only a question whose options run A, B, C… with the tail missing can say
    // where the tail begins. A gap in the middle means something else went
    // wrong, and guessing which label is absent would hand it the wrong text.
    if (!held.every((label, index) => label.charCodeAt(0) === A + index)) return null
    // Without the paper's option count there is no way to know how many are
    // still owed, so there is no way to tell a complete tail from a fragment.
    if (expected === null || held.length >= expected) return null

    startCode = A + held.length
    need = expected - held.length
  }

  const limit = firstQuestionAt(text)
  // Everything above the first question on the page. If a question starts at
  // the very top there is no room for a carried block and nothing to find.
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

  // Three is the fewest that can look like a list rather than a coincidence,
  // and it is what a question that kept nothing has to produce. A question
  // that kept some of its options needs only the rest, and the label it has to
  // start at plus the count it has to reach are together the stronger evidence.
  const minimum = held.length > 0 ? need! : 3
  if (marks.length < minimum) return null

  const start = marks.findIndex((mark) => mark.label.charCodeAt(0) === startCode)
  if (start === -1) return null

  // A tail has to be the first thing on the page. Options printed above it
  // mean this is a complete list belonging to something else, not the rest of
  // one that began on the page before.
  if (held.length > 0 && start !== 0) return null

  const run: CarriedChoice[] = []
  let expectedCode = startCode

  for (let index = start; index < marks.length; index += 1) {
    const mark = marks[index]
    if (mark.label.charCodeAt(0) !== expectedCode) break

    const endsAt = marks[index + 1]?.at ?? head.length
    const body = head.slice(mark.textFrom, endsAt).trim()

    // An option with nothing in it, or with a paragraph in it, is not an
    // option; it is a coincidence of punctuation.
    if (body.length === 0 || body.length > MAX_OPTION_TEXT) break

    run.push({ label: mark.label, text: normalizeMath(body) })
    expectedCode += 1
  }

  if (run.length < minimum) return null

  // The paper says how many options a question has. A run that does not bring
  // the question up to that count is either a fragment or something else
  // entirely.
  if (need !== null && run.length !== need) return null

  return run
}
