export interface PageRange {
  from: number
  to: number | null
}

export type PageRangeResult =
  | { ok: true; range: PageRange | null }
  | { ok: false; message: string }

export function parsePageRange(fromRaw: string, toRaw: string): PageRangeResult {
  const fromText = fromRaw.trim()
  const toText = toRaw.trim()

  if (!fromText && !toText) return { ok: true, range: null }

  const from = fromText ? Number(fromText) : 1
  const to = toText ? Number(toText) : null

  if (!Number.isInteger(from) || from < 1) {
    return { ok: false, message: 'First page must be a whole number, 1 or more.' }
  }

  if (to !== null && (!Number.isInteger(to) || to < 1)) {
    return { ok: false, message: 'Last page must be a whole number, 1 or more.' }
  }

  if (to !== null && to < from) {
    return { ok: false, message: `Last page can't be before page ${from}.` }
  }

  return { ok: true, range: { from, to } }
}

export type QuestionCountResult =
  | { ok: true; count: number | null }
  | { ok: false; message: string }

export function parseQuestionCount(raw: string): QuestionCountResult {
  const text = raw.trim()
  if (!text) return { ok: true, count: null }

  const count = Number(text)

  if (!Number.isInteger(count) || count < 1) {
    return { ok: false, message: 'Question count must be a whole number, 1 or more.' }
  }

  return { ok: true, count }
}

export function pageInRange(pageNumber: number, range: PageRange | null): boolean {
  if (!range) return true
  if (pageNumber < range.from) return false
  return range.to === null || pageNumber <= range.to
}

export function countInRange(totalPages: number, range: PageRange | null): number {
  if (!range) return totalPages
  const last = range.to === null ? totalPages : Math.min(range.to, totalPages)
  return Math.max(0, last - range.from + 1)
}

export function describePageRange(range: PageRange | null): string {
  if (!range) return 'every page'
  if (range.to === null) return `page ${range.from} onwards`
  if (range.to === range.from) return `page ${range.from}`
  return `pages ${range.from}–${range.to}`
}
