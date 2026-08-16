import { sortWithinPage, type PagePosition } from './page-text'
import { validateQuestion, type ValidatableQuestion } from './validate'

/**
 * A question cut in half by a page break.
 *
 * Extraction reads one page at a time and the model never sees the page before
 * or after, so a question whose stem ends at the foot of page N and whose
 * options begin at the head of page N+1 is never whole in either request. On
 * the AMC8 2024 paper the stem of question 11 came back off page 2 with no
 * options at all, and page 3 produced a separate row holding the figure labels
 * "C(3,y) A(5,7) B(11,7)" and the five options that belong to it. Two rows,
 * one question, and the sheet counted 26 on a paper that has 25.
 *
 * Both halves are recognisable without a model. The first is a real question
 * missing its options; the second asks nothing, which validate.ts already
 * names stem_is_not_a_question.
 */
export interface SplitHalf extends ValidatableQuestion, PagePosition {
  id: string
  pageNumber: number | null
}

export interface SplitJoin {
  /** The half holding the stem. It survives and gains the other's options. */
  keepId: string
  /** The half holding the options. It is deleted once they have moved. */
  dropId: string
  /** Number the surviving row should end up with. */
  printedNumber: number | null
  /** Why the pair was joined, for the log. */
  reason: string
}

/** Question types where missing options mean something was lost. */
const CHOICE_BEARING = new Set(['multiple_choice', 'true_false'])

function flagCodes(question: ValidatableQuestion): Set<string> {
  return new Set(validateQuestion(question).map((flag) => flag.code))
}

/** A stem that asks something, which is what the first half must look like. */
function asksSomething(question: SplitHalf): boolean {
  const codes = flagCodes(question)
  return !codes.has('stem_is_not_a_question') && !codes.has('empty_stem')
}

/** A stem that asks nothing, which is what the orphaned options look like. */
function asksNothing(question: SplitHalf): boolean {
  return flagCodes(question).has('stem_is_not_a_question')
}

/**
 * Finds questions whose stem and options were separated by a page break.
 *
 * Deliberately refuses more often than it acts. Joining is a deletion, and
 * this codebase has already been bitten twice by a rule that read correctly
 * and was wrong on real data, so every condition below has to hold: the first
 * half is the last question on its page and asks something without offering
 * any answers, the second half is the first question on the very next page and
 * offers a full set of answers while asking nothing, and neither carries a
 * printed number that contradicts the other. Anything else is left alone for
 * the student to see and fix, which is the recoverable failure.
 */
export function planPageSplitJoins(
  questions: SplitHalf[],
  options: { expectedChoiceCount?: number | null } = {},
): SplitJoin[] {
  const byPage = new Map<number, SplitHalf[]>()

  for (const question of questions) {
    // A question with no page cannot be placed either side of a break.
    if (question.pageNumber === null) continue
    byPage.set(question.pageNumber, [...(byPage.get(question.pageNumber) ?? []), question])
  }

  for (const [pageNumber, page] of byPage) byPage.set(pageNumber, sortWithinPage(page))

  const expected = options.expectedChoiceCount ?? null
  const joins: SplitJoin[] = []

  for (const pageNumber of [...byPage.keys()].sort((a, b) => a - b)) {
    const current = byPage.get(pageNumber)!
    // The next page specifically, not the next page that happens to hold
    // questions. If the page in between produced nothing, the options are on
    // it and whatever sits two pages later is a different question.
    const next = byPage.get(pageNumber + 1)
    if (!next || next.length === 0) continue

    const head = current[current.length - 1]
    const tail = next[0]

    // The stem half: a real question, of a type that should have options,
    // holding none of them, at the very bottom of the page.
    if (!CHOICE_BEARING.has(head.questionType)) continue
    if (head.choices.length > 0) continue
    if (!asksSomething(head)) continue

    // The options half: a full set of answers under something that asks
    // nothing: a figure caption, a stray coordinate, a bare label.
    if (tail.choices.length < 2) continue
    if (!asksNothing(tail)) continue

    // A partial set of options is not the shape this repairs: it would mean
    // the answers were split too, and guessing which are missing is exactly
    // the guess that must not be made.
    if (expected !== null && tail.choices.length !== expected) continue

    // Two different printed numbers means two different questions, whatever
    // else they look like.
    if (
      head.printedNumber !== null &&
      tail.printedNumber !== null &&
      head.printedNumber !== tail.printedNumber
    ) {
      continue
    }

    joins.push({
      keepId: head.id,
      dropId: tail.id,
      printedNumber: head.printedNumber ?? tail.printedNumber,
      reason:
        `question ${head.printedNumber ?? '?'} runs from page ${pageNumber} ` +
        `to page ${pageNumber + 1}: ${tail.choices.length} option(s) rejoined`,
    })
  }

  return joins
}
