export type PageFindings = {
  pageNumber: number
  printed: number[]
  expectsQuestions?: boolean
}

export type RetryTarget = {
  pageNumber: number
  expect: number[]
}

export type AuditResult = {
  missing: number[]
  retry: RetryTarget[]
  found: number
  expected: number | null
  extra: number[]
  silent: number[]
}

function byNumber(a: number, b: number) {
  return a - b
}

export function auditExtraction(
  pages: PageFindings[],
  expectedTotal: number | null,
): AuditResult {
  const seen = new Set<number>()

  for (const page of pages) {
    for (const number of page.printed) {
      if (Number.isInteger(number) && number >= 1) seen.add(number)
    }
  }

  let lowest = 1
  let highest = 0

  if (seen.size > 0) {
    let first = true

    for (const number of seen) {
      if (first) {
        lowest = number
        highest = number
        first = false
        continue
      }

      if (number < lowest) lowest = number
      if (number > highest) highest = number
    }
  }

  let expected: number | null = null
  if (expectedTotal !== null && expectedTotal > 0) expected = expectedTotal

  let ceiling = highest
  if (expected !== null && lowest === 1 && expected > highest) ceiling = expected

  const missing: number[] = []
  for (let number = lowest; number <= ceiling; number++) {
    if (!seen.has(number)) missing.push(number)
  }

  const silent: number[] = []
  for (const page of pages) {
    if (page.expectsQuestions === true && page.printed.length === 0) {
      silent.push(page.pageNumber)
    }
  }

  silent.sort(byNumber)

  const retry = pagesToRetry(pages, missing, silent)

  const targeted = new Set<number>()
  for (const target of retry) targeted.add(target.pageNumber)

  for (const pageNumber of silent) {
    if (!targeted.has(pageNumber)) retry.push({pageNumber, expect: []})
  }

  retry.sort(function (a, b) {
    return a.pageNumber - b.pageNumber
  })

  const extra: number[] = []
  if (expected) {
    for (const number of seen) {
      if (number > expected) extra.push(number)
    }

    extra.sort(byNumber)
  }

  return {
    missing,
    retry,
    found: seen.size,
    expected,
    extra,
    silent,
  }
}

type NumberedPage = {
  pageNumber: number
  low: number
  high: number
}

function pagesToRetry(
  pages: PageFindings[],
  missing: number[],
  silent: number[],
): RetryTarget[] {
  if (missing.length === 0) return []

  const numbered: NumberedPage[] = []

  for (const page of pages) {
    if (page.printed.length === 0) continue

    let low = page.printed[0]
    let high = page.printed[0]

    for (const number of page.printed) {
      if (number < low) low = number
      if (number > high) high = number
    }

    numbered.push({pageNumber: page.pageNumber, low: low, high: high})
  }

  numbered.sort(function (a, b) {
    return a.pageNumber - b.pageNumber
  })

  const expectByPage = new Map<number, Set<number>>()

  function add(pageNumber: number, number: number) {
    let set = expectByPage.get(pageNumber)

    if (!set) {
      set = new Set<number>()
      expectByPage.set(pageNumber, set)
    }

    set.add(number)
  }

  for (const number of missing) {
    const containing: NumberedPage[] = []
    for (const page of numbered) {
      if (number > page.low && number < page.high) containing.push(page)
    }

    if (containing.length > 0) {
      for (const page of containing) add(page.pageNumber, number)
      continue
    }

    let before: NumberedPage | null = null
    for (const page of numbered) {
      if (page.high < number) before = page
    }

    let after: NumberedPage | null = null
    for (const page of numbered) {
      if (page.low > number) {
        after = page
        break
      }
    }

    const between: number[] = []
    for (const pageNumber of silent) {
      if (before && pageNumber <= before.pageNumber) continue
      if (after && pageNumber >= after.pageNumber) continue

      between.push(pageNumber)
    }

    if (between.length > 0) {
      for (const pageNumber of between) add(pageNumber, number)
      continue
    }

    if (before) add(before.pageNumber, number)
    if (after) add(after.pageNumber, number)

    if (!before && !after) {
      for (const page of pages) {
        if (page.printed.length === 0) add(page.pageNumber, number)
      }
    }
  }

  const targets: RetryTarget[] = []

  for (const [pageNumber, expect] of expectByPage) {
    const wanted: number[] = []
    for (const number of expect) wanted.push(number)

    wanted.sort(byNumber)

    targets.push({pageNumber, expect: wanted})
  }

  targets.sort(function (a, b) {
    return a.pageNumber - b.pageNumber
  })

  return targets
}
