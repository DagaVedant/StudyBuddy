/**
 * Reads the answer options a page break carried onto the next page.
 *
 * The join in split-pages.ts repairs a split only when the extractor returned
 * both halves. Often it returns one: a bare block of options with no question
 * above it is not a question, so the model drops it, and the stem at the foot
 * of the previous page keeps no record that its answers ever existed. On the
 * AMC8 2024 paper that is four of the five splits — questions 5, 14, 18 and 23
 * each lost every option they had, and no second row was ever written to join.
 *
 * The options are still on the page, in the text layer, above the first
 * question printed there. Reading them from the text costs nothing, needs no
 * model, and does not depend on the extractor having noticed them.
 */
import { normalizeMath } from './math'

export interface CarriedChoice {
  label: string
  text: string
}

/**
 * A question beginning on this page: a printed number, then the start of a
 * sentence.
 *
 * Deliberately demands prose after the number. Papers are full of lines like
 * "5 2 6 5" and "8 14 10" — distances written along a diagram — and treating
 * one of those as the first question would hide a genuine carried-over block
 * behind it.
 */
const QUESTION_START = /^[ \t]*\(?(\d{1,3})[.)]?[ \t]+(?=[A-Z(])(.{12,})$/gm
const PROSE = /[a-z]{3,}/g

/**
 * A labelled option: "(A) 28", "A. 28", "(a) 28".
 *
 * The lookbehind keeps it from firing inside a word or a number, which is what
 * separates a real option list from the middle of a sentence.
 */
const OPTION = /(?<![\p{L}\p{N}])\(?([A-Za-z])[).][ \t]+/gu

/** Longest an option's text may run before it stops looking like an option. */
const MAX_OPTION_TEXT = 300

function looksLikeQuestion(line: string): boolean {
  return (line.match(PROSE) ?? []).length >= 3
}

/** Offset of the first real question printed on the page, or the whole page. */
function firstQuestionAt(text: string): number {
  QUESTION_START.lastIndex = 0

  for (let match = QUESTION_START.exec(text); match; match = QUESTION_START.exec(text)) {
    if (looksLikeQuestion(match[2])) return match.index
  }

  return text.length
}

/**
 * Pulls the options a question left behind on the page after it.
 *
 * Returns null unless the page opens with one complete, consecutive run of
 * options — A, B, C and so on from the top — printed above everything else on
 * the page. Anything less is left alone: these options are about to be handed
 * to a question that currently has none, and handing it the wrong ones is
 * worse than leaving it visibly incomplete for the student to fix.
 */
export function parseCarriedChoices(
  pageText: string,
  options: { expectedCount?: number | null } = {},
): CarriedChoice[] | null {
  const text = pageText ?? ''
  if (text.trim().length === 0) return null

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

  if (marks.length < 3) return null

  // The run has to open at A. A block starting anywhere else is the tail of a
  // list whose head is on some other page, and there is no telling how much of
  // it is missing.
  const start = marks.findIndex((mark) => mark.label === 'A')
  if (start === -1) return null

  const run: CarriedChoice[] = []
  let expectedCode = 'A'.charCodeAt(0)

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

  if (run.length < 3) return null

  const expected = options.expectedCount ?? null
  // The paper says how many options a question has. A run that does not match
  // it is either a fragment or something else entirely.
  if (expected !== null && run.length !== expected) return null

  return run
}
