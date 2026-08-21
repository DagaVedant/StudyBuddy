export const MAX_PAGES_PER_UPLOAD = 75

export const RASTER_DPI = 150
export const RASTER_MAX_EDGE = 2200

export const MAX_PAGE_BYTES = 4 * 1024 * 1024
export const MAX_SOURCE_BYTES = 64 * 1024 * 1024
export const MAX_PAGE_DIMENSION = 5000

export const MAX_SOURCE_PAGE_NUMBER = 2000

export const MAX_DECODED_PIXELS = MAX_PAGE_DIMENSION * MAX_PAGE_DIMENSION

export function pageCapFor(role: 'student' | 'admin'): number {
  return role === 'admin' ? Number.POSITIVE_INFINITY : MAX_PAGES_PER_UPLOAD
}

export interface PageRange {
  from: number
  to: number | null
}

export type PageRangeResult =
  | {ok: true; range: PageRange | null}
  | {ok: false; message: string}

export function parsePageRange(fromRaw: string, toRaw: string): PageRangeResult {
  const fromText = fromRaw.trim()
  const toText = toRaw.trim()

  if (!fromText && !toText) return {ok: true, range: null}

  const from = fromText ? Number(fromText) : 1
  const to = toText ? Number(toText) : null

  if (!Number.isInteger(from) || from < 1) {
    return {ok: false, message: 'First page must be a whole number, 1 or more.'}
  }

  if (to !== null && (!Number.isInteger(to) || to < 1)) {
    return {ok: false, message: 'Last page must be a whole number, 1 or more.'}
  }

  if (to !== null && to < from) {
    return {ok: false, message: `Last page can't be before page ${from}.`}
  }

  return {ok: true, range: {from, to}}
}

export type QuestionCountResult =
  | {ok: true; count: number | null}
  | {ok: false; message: string}

export function parseQuestionCount(raw: string): QuestionCountResult {
  const text = raw.trim()
  if (!text) return {ok: true, count: null}

  const count = Number(text)

  if (!Number.isInteger(count) || count < 1) {
    return {ok: false, message: 'Question count must be a whole number, 1 or more.'}
  }

  return {ok: true, count}
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

export function destination(
  id: string,
  worksheet: {status: string; questionCount: number; markedCount: number},
): {href: string; cta: string} {
  switch (worksheet.status) {
    case 'uploading':
    case 'queued':
    case 'processing':
      return {href: `/worksheets/${id}/status`, cta: 'Processing'}
    case 'awaiting_review':
      return worksheet.questionCount > 0
        ? {href: `/worksheets/${id}/check`, cta: 'Check questions'}
        : {href: `/worksheets/${id}/edit`, cta: 'Add questions'}
    case 'failed':
      return {href: `/worksheets/${id}/status`, cta: 'See what happened'}
    default:
      return worksheet.markedCount > 0
        ? {href: `/worksheets/${id}/markup`, cta: 'See your marks'}
        : {href: `/worksheets/${id}/markup`, cta: 'Mark answers'}
  }
}

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2'
export const EMBEDDING_DIMENSIONS = 384

export const EMBEDDING_INPUT_LIMIT = 2000

export const MIN_ATTEMPTS = 5
