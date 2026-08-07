/**
 * Puts the questions on one page into the order they are printed in.
 *
 * Three sources, and each is used only when it covers the whole page, because
 * a page ordered by two different measures is ordered by neither. Measured on
 * the AMC8 2024 paper, every one of them is wrong somewhere:
 *
 * - The number printed on the paper is the student's own order and the best
 *   evidence there is, but the extractor drops it, and the half of a split
 *   question that holds only options never had one.
 * - The bbox describes the page rather than the extraction, which is what
 *   makes it the answer when a number is missing. It is not exact: on page 1
 *   question 4 came back with a top of 1428 and question 5 with 1379, so
 *   geometry alone puts them the wrong way round.
 * - The ordinal records the order rows were written, which matches the page
 *   only until the audit and review re-reads add more, and only until
 *   renumberQuestions rewrites it.
 */
export interface PagePosition {
  printedNumber: number | null
  /** Top edge of the question's bbox, in pixels down the page. */
  top: number | null
  /** Ordinal, or whatever order the rows arrived in. */
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

  // Ordinal breaks a tie rather than leaving it to sort stability, so the
  // answer does not depend on what order the rows were read out of the table.
  return [...page].sort((a, b) => key(a) - key(b) || a.position - b.position)
}
