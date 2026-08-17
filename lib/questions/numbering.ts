import { normalizeMath } from './math'

export interface PageOption {
  label: string
  text: string
}

export interface PageQuestion {
  number: number
  stem: string
  options: PageOption[]
}

const NUMBERED_LINE = /^[ \t]*\(?(\d{1,3})[.)][ \t]+(.*)$/gm
const OPTION_LINE = /^[ \t]*\(?([A-Za-z])[).][ \t]+(.*)$/gm
const MAX_OPTION_TEXT = 300

const A = 'A'.charCodeAt(0)

function nextLabelInside(body: string, code: number): boolean {
  if (code > 'Z'.charCodeAt(0)) return false

  const label = String.fromCharCode(code)
  return new RegExp(`(?<![\\p{L}\\p{N}])\\(?[${label}${label.toLowerCase()}][).][ \\t]`, 'u').test(
    body,
  )
}

export function questionsOnPage(pageText: string): PageQuestion[] {
  const text = pageText ?? ''

  const starts: { number: number; at: number; bodyFrom: number }[] = []
  NUMBERED_LINE.lastIndex = 0

  for (let match = NUMBERED_LINE.exec(text); match; match = NUMBERED_LINE.exec(text)) {
    starts.push({
      number: Number(match[1]),
      at: match.index,
      bodyFrom: match.index + match[0].length - match[2].length,
    })
  }

  return starts.map((start, index) => {
    const block = text.slice(start.bodyFrom, starts[index + 1]?.at ?? text.length)

    const marks: { label: string; at: number; textFrom: number }[] = []
    OPTION_LINE.lastIndex = 0

    for (let match = OPTION_LINE.exec(block); match; match = OPTION_LINE.exec(block)) {
      marks.push({
        label: match[1].toUpperCase(),
        at: match.index,
        textFrom: match.index + match[0].length - match[2].length,
      })
    }

    let options: PageOption[] = []
    for (const [position, mark] of marks.entries()) {
      if (mark.label.charCodeAt(0) !== A + position) break

      const endsAt = marks[position + 1]?.at ?? block.length
      const body = block.slice(mark.textFrom, endsAt).trim()

      if (body.length === 0 || body.length > MAX_OPTION_TEXT) break

      if (nextLabelInside(body, A + position + 1)) {
        options = []
        break
      }

      options.push({ label: mark.label, text: normalizeMath(body) })
    }

    const stemEnd = marks[0]?.at ?? block.length

    return {
      number: start.number,
      stem: normalizeMath(block.slice(0, stemEnd).trim()),
      options,
    }
  })
}

const MIN_MATCH = 24
const COMPARE = 40

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function sameOpening(a: string, b: string): boolean {
  const left = a.slice(0, COMPARE)
  const right = b.slice(0, COMPARE)
  if (left.length < MIN_MATCH || right.length < MIN_MATCH) return false
  return left.startsWith(right) || right.startsWith(left)
}

export function printedNumbersFor(
  pageText: string,
  prompts: readonly string[],
): (number | null)[] {
  const stems = questionsOnPage(pageText ?? '').map((question) => ({
    number: question.number,
    head: normalize(question.stem),
  }))

  if (stems.length === 0) return prompts.map(() => null)

  const taken = new Set<number>()

  return prompts.map((prompt) => {
    const head = normalize(prompt ?? '')

    const hit = stems.find((stem) => !taken.has(stem.number) && sameOpening(stem.head, head))
    if (!hit) return null

    taken.add(hit.number)
    return hit.number
  })
}

export interface NumberedQuestion {
  id: string
  pageNumber: number | null
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

  const ceiling = expectedTotal && expectedTotal > 0
    ? expectedTotal
    : Math.max(...trusted.values())

  const taken = new Set(trusted.values())
  const available: number[] = []
  for (let n = 1; n <= ceiling; n += 1) if (!taken.has(n)) available.push(n)
  if (available.length === 0) return []

  const fixes: NumberFix[] = []

  let index = 0
  while (index < ordered.length) {
    if (trusted.has(ordered[index].id)) {
      index += 1
      continue
    }

    let end = index
    while (end < ordered.length && !trusted.has(ordered[end].id)) end += 1

    const run = ordered.slice(index, end)

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
