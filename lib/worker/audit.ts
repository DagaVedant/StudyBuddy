export interface PageFindings {
  pageNumber: number
  printed: number[]
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

  return {
    missing,
    retry: pagesToRetry(pages, missing),
    found: seen.size,
    expected,
    extra: expected ? [...seen].filter((n) => n > expected).sort((a, b) => a - b) : [],
  }
}

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
    const containing = numbered.filter((p) => number > p.low && number < p.high)
    if (containing.length > 0) {
      for (const page of containing) add(page.pageNumber, number)
      continue
    }

    const before = [...numbered].reverse().find((p) => p.high < number)
    const after = numbered.find((p) => p.low > number)

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
