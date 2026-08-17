export interface PageFindings {
  pageNumber: number
  printed: number[]
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
  extra: number[]
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
