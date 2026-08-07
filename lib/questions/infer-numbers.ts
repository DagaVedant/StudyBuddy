/**
 * Works out the number a question was printed with when the model lost it.
 *
 * Across two real papers every "missing" question but one turned out to be
 * present and mislabelled: three arrived with no number at all, and question
 * 113 arrived labelled 1. The questions were read correctly; only the label
 * failed, and the label is what coverage is measured against.
 *
 * Position is the evidence. A question sitting on page 5 between question 3
 * and question 5, on a paper whose only gap is 4, is question 4. Nothing else
 * it could be.
 *
 * Deliberately refuses to guess. A number is assigned only when exactly one
 * candidate fits the space, so an ambiguous run is left for the student rather
 * than filled with a plausible lie. A wrong number is worse than a blank one:
 * blank is visibly unfinished, wrong looks finished and is not.
 */
export interface NumberedQuestion {
  id: string
  /** Page it was found on. Null sorts last, as an unplaced question. */
  pageNumber: number | null
  /** Order within the whole worksheet, used to break ties inside a page. */
  position: number
  printedNumber: number | null
}

export interface NumberFix {
  id: string
  from: number | null
  to: number
  reason: 'filled-blank' | 'corrected-stray'
}

function inOrder(items: NumberedQuestion[]): NumberedQuestion[] {
  return [...items].sort((a, b) => {
    const pageA = a.pageNumber ?? Number.MAX_SAFE_INTEGER
    const pageB = b.pageNumber ?? Number.MAX_SAFE_INTEGER
    if (pageA !== pageB) return pageA - pageB
    return a.position - b.position
  })
}

/**
 * Numbers we can believe, which is what everything else is measured against.
 *
 * A number is trusted when it appears exactly once and does not go backwards
 * against the numbers around it. Both tests matter: the stray 1 on the last
 * page of a 114 question paper was a duplicate *and* out of sequence, and
 * either check alone would have let one of the real failures through.
 */
function trustedNumbers(ordered: NumberedQuestion[]): Map<string, number> {
  const seen = new Map<number, number>()
  for (const item of ordered) {
    if (item.printedNumber !== null) {
      seen.set(item.printedNumber, (seen.get(item.printedNumber) ?? 0) + 1)
    }
  }

  const unique = ordered.filter(
    (item) => item.printedNumber !== null && seen.get(item.printedNumber) === 1,
  )

  // Longest run of numbers that only ever increases. Anything off that run is
  // out of place relative to its neighbours, whatever its value.
  const best: number[] = []
  const from: number[] = new Array(unique.length).fill(-1)
  const length: number[] = new Array(unique.length).fill(1)

  for (let i = 0; i < unique.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      const rising = (unique[j].printedNumber as number) < (unique[i].printedNumber as number)
      if (rising && length[j] + 1 > length[i]) {
        length[i] = length[j] + 1
        from[i] = j
      }
    }
  }

  let end = length.indexOf(Math.max(...length, 0))
  while (end >= 0) {
    best.unshift(end)
    end = from[end]
  }

  const trusted = new Map<string, number>()
  for (const index of best) {
    const item = unique[index]
    trusted.set(item.id, item.printedNumber as number)
  }
  return trusted
}

export function inferPrintedNumbers(
  items: NumberedQuestion[],
  expectedTotal: number | null,
): NumberFix[] {
  if (items.length === 0) return []

  const ordered = inOrder(items)
  const trusted = trustedNumbers(ordered)
  if (trusted.size === 0) return []

  // Everything the paper should have, minus what we already believe.
  const ceiling = expectedTotal && expectedTotal > 0
    ? expectedTotal
    : Math.max(...trusted.values())

  const taken = new Set(trusted.values())
  const available: number[] = []
  for (let n = 1; n <= ceiling; n += 1) if (!taken.has(n)) available.push(n)
  if (available.length === 0) return []

  const fixes: NumberFix[] = []

  // Walk the runs of unreliable questions between two trusted anchors.
  let index = 0
  while (index < ordered.length) {
    if (trusted.has(ordered[index].id)) {
      index += 1
      continue
    }

    let end = index
    while (end < ordered.length && !trusted.has(ordered[end].id)) end += 1

    const run = ordered.slice(index, end)

    // A run at the very start has no lower anchor, so the floor is 0; at the
    // very end there is no upper anchor, so the ceiling is the paper's total.
    let low = 0
    for (let back = index - 1; back >= 0; back -= 1) {
      const anchor = trusted.get(ordered[back].id)
      if (anchor !== undefined) { low = anchor; break }
    }

    let high = ceiling + 1
    for (let forward = end; forward < ordered.length; forward += 1) {
      const anchor = trusted.get(ordered[forward].id)
      if (anchor !== undefined) { high = anchor; break }
    }

    const candidates = available.filter((n) => n > low && n < high)

    // Only when the space and the questions in it match exactly. One spare
    // number and two blanks is a guess, and this does not guess.
    if (candidates.length === run.length) {
      for (const [offset, item] of run.entries()) {
        const to = candidates[offset]
        if (item.printedNumber === to) continue
        fixes.push({
          id: item.id,
          from: item.printedNumber,
          to,
          reason: item.printedNumber === null ? 'filled-blank' : 'corrected-stray',
        })
      }
    }

    index = end
  }

  return fixes
}
