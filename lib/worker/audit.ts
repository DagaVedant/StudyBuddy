/**
 * Finds the questions a first extraction pass missed.
 *
 * A printed exam numbers its questions consecutively, and the vision model
 * reports those numbers accurately even when it packages the questions wrong.
 * That makes coverage arithmetic rather than inference: a number that never
 * arrived is a miss, and its neighbours say which page to look on.
 *
 * A second model reviewing the first model's work was the alternative. It
 * would cost another full pass to produce a guess where subtraction gives
 * proof, and when the two disagreed there would be no way to know which to
 * believe. Use a model to read a page; use code to check the result.
 */

export interface PageFindings {
  pageNumber: number
  /** Printed numbers seen on the page. Unnumbered questions are omitted. */
  printed: number[]
}

export interface RetryTarget {
  pageNumber: number
  /** The numbers this page is expected to contain. */
  expect: number[]
}

export interface AuditResult {
  missing: number[]
  retry: RetryTarget[]
  found: number
  expected: number | null
}

/**
 * @param expectedTotal what the student said the worksheet contains, if
 *   anything. Holes *inside* the observed range are found without it — only
 *   questions missing off the end need the total to be detectable.
 */
export function auditExtraction(
  pages: PageFindings[],
  expectedTotal: number | null = null,
): AuditResult {
  const seen = new Set<number>()
  for (const page of pages) {
    for (const number of page.printed) {
      if (Number.isInteger(number) && number >= 1) seen.add(number)
    }
  }

  const hasNumbers = seen.size > 0
  // With nothing found at all, the span can only come from the student's
  // total — and a pass that produced nothing is exactly when a retry matters.
  const lowest = hasNumbers ? Math.min(...seen) : 1
  const highest = hasNumbers ? Math.max(...seen) : 0

  /*
   * Audit within the range actually observed, not from 1.
   *
   * Uploads can be a slice of a document — the page range exists precisely so
   * a student can take pages 30-59 of a form, where the questions start at 47.
   * Counting from 1 would report the first 46 as missing and send the worker
   * off to re-read pages that never contained them.
   *
   * The student's total only extends the ceiling when the numbering starts at
   * 1, since that is the only case where "114 questions" is known to describe
   * the same span as what was uploaded.
   */
  const ceiling =
    expectedTotal && expectedTotal > 0 && lowest === 1
      ? Math.max(expectedTotal, highest)
      : highest

  // No numbering anywhere and no total: nothing to audit. Not one huge gap.

  const missing: number[] = []
  for (let number = lowest; number <= ceiling; number += 1) {
    if (number >= 1 && !seen.has(number)) missing.push(number)
  }

  return {
    missing,
    retry: pagesToRetry(pages, missing),
    found: seen.size,
    expected: expectedTotal && expectedTotal > 0 ? expectedTotal : null,
  }
}

/**
 * Maps each missing number to the page it most likely sits on, by finding the
 * pages holding its nearest numbered neighbours. A missing 47 between a page
 * ending at 46 and a page starting at 48 could be on either, so both are
 * retried — re-reading one extra page is far cheaper than missing a question.
 */
function pagesToRetry(pages: PageFindings[], missing: number[]): RetryTarget[] {
  if (missing.length === 0) return []

  const numbered = pages
    .filter((page) => page.printed.length > 0)
    .map((page) => ({
      pageNumber: page.pageNumber,
      low: Math.min(...page.printed),
      high: Math.max(...page.printed),
    }))
    .sort((a, b) => a.pageNumber - b.pageNumber)

  const expectByPage = new Map<number, Set<number>>()

  const add = (pageNumber: number, number: number) => {
    const set = expectByPage.get(pageNumber) ?? new Set<number>()
    set.add(number)
    expectByPage.set(pageNumber, set)
  }

  for (const number of missing) {
    // A page whose own range already brackets the number owns it outright.
    const containing = numbered.filter((p) => number > p.low && number < p.high)
    if (containing.length > 0) {
      for (const page of containing) add(page.pageNumber, number)
      continue
    }

    const before = [...numbered].reverse().find((p) => p.high < number)
    const after = numbered.find((p) => p.low > number)

    if (before) add(before.pageNumber, number)
    if (after) add(after.pageNumber, number)

    // Nothing numbered anywhere near it — a wholly blank first pass. Retry the
    // pages that produced nothing rather than giving up.
    if (!before && !after) {
      for (const page of pages.filter((p) => p.printed.length === 0)) {
        add(page.pageNumber, number)
      }
    }
  }

  return [...expectByPage.entries()]
    .map(([pageNumber, expect]) => ({
      pageNumber,
      expect: [...expect].sort((a, b) => a - b),
    }))
    .sort((a, b) => a.pageNumber - b.pageNumber)
}
