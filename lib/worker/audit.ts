export interface PageFindings {
  pageNumber: number
  printed: number[]
  /**
   * Whether the page's own text prints questions.
   *
   * The audit works from the printed numbering alone, so a page that returned
   * nothing is invisible to it as long as some other page supplied the numbers
   * that page was carrying. That is exactly what happened to `test8_15`: its
   * solutions page produced rows numbered 8 to 15, the audit read 15 of 15 and
   * reported 100 % recall, and pages 2 and 3 — which had come back empty — were
   * never re-read. Half the paper was missing and the only check that could
   * have caught it passed.
   *
   * Absent when the caller cannot tell, which is read as "no", so a caller
   * written before this keeps the behaviour it had.
   */
  expectsQuestions?: boolean
}

export interface RetryTarget {
  pageNumber: number
  expect: number[]
}

export interface AuditResult {
  missing: number[]
  retry: RetryTarget[]
  found: number
  expected: number | null
  /**
   * Printed numbers above the total the student gave us.
   *
   * The audit used to only look for gaps, so extraction coming back with
   * *more* questions than the paper has counted as a clean run. It is not:
   * it means a number was misread, or one question was picked up twice. We
   * cannot tell which from here, and deleting someone's questions on a guess
   * is worse than showing too many, so this is reported rather than acted on.
   */
  extra: number[]
  /**
   * Pages that print questions and returned none.
   *
   * A failure in its own right, not a warning: it does not depend on the
   * numbering being complete, which is the point, because the numbering can be
   * complete and wrong. Every one of these is re-read even when nothing looks
   * missing.
   */
  silent: number[]
}

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
  const lowest = hasNumbers ? Math.min(...seen) : 1
  const highest = hasNumbers ? Math.max(...seen) : 0

  const ceiling =
    expectedTotal && expectedTotal > 0 && lowest === 1
      ? Math.max(expectedTotal, highest)
      : highest

  const missing: number[] = []
  for (let number = lowest; number <= ceiling; number += 1) {
    if (number >= 1 && !seen.has(number)) missing.push(number)
  }

  const expected = expectedTotal && expectedTotal > 0 ? expectedTotal : null

  const silent = pages
    .filter((page) => page.expectsQuestions === true && page.printed.length === 0)
    .map((page) => page.pageNumber)
    .sort((a, b) => a - b)

  const retry = pagesToRetry(pages, missing, silent)
  const targeted = new Set(retry.map((target) => target.pageNumber))

  // Added whether or not anything looks missing. A page that printed questions
  // and returned none is worth another look on its own evidence, and waiting
  // for a gap in the numbering to appear is what let a sheet missing eight of
  // its fifteen questions past.
  for (const pageNumber of silent) {
    if (!targeted.has(pageNumber)) retry.push({ pageNumber, expect: [] })
  }

  return {
    missing,
    retry: retry.sort((a, b) => a.pageNumber - b.pageNumber),
    found: seen.size,
    expected,
    extra: expected ? [...seen].filter((n) => n > expected).sort((a, b) => a - b) : [],
    silent,
  }
}

function pagesToRetry(
  pages: PageFindings[],
  missing: number[],
  silent: number[],
): RetryTarget[] {
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
    const containing = numbered.filter((p) => number > p.low && number < p.high)
    if (containing.length > 0) {
      for (const page of containing) add(page.pageNumber, number)
      continue
    }

    const before = [...numbered].reverse().find((p) => p.high < number)
    const after = numbered.find((p) => p.low > number)

    // A page that prints questions and returned none, sitting between the last
    // page numbered below this and the first numbered above it, is where this
    // question was. Better evidence than either neighbour, so it takes the
    // number on its own: `test8_15` lost pages 2 and 3, and blaming page 1 for
    // questions 8 to 14 would re-read a page that never held them.
    const between = silent.filter(
      (pageNumber) =>
        (!before || pageNumber > before.pageNumber) &&
        (!after || pageNumber < after.pageNumber),
    )

    if (between.length > 0) {
      for (const pageNumber of between) add(pageNumber, number)
      continue
    }

    if (before) add(before.pageNumber, number)
    if (after) add(after.pageNumber, number)

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
