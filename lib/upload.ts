export const MAX_PAGES_PER_UPLOAD = 75

export const RASTER_DPI = 150
export const RASTER_MAX_EDGE = 2200

export const MAX_PAGE_BYTES = 4 * 1024 * 1024
export const MAX_SOURCE_BYTES = 64 * 1024 * 1024
export const MAX_PAGE_DIMENSION = 5000

export const MAX_SOURCE_PAGE_NUMBER = 2000

export const MAX_DECODED_PIXELS = MAX_PAGE_DIMENSION * MAX_PAGE_DIMENSION

export function pageCapFor(role: 'student' | 'admin') {
  if (role === 'admin') return Infinity
  return MAX_PAGES_PER_UPLOAD
}

export type PageRange = {
  from: number
  to: number | null
}

export type PageRangeResult = {
  ok: boolean
  range: PageRange | null
  message: string
}

export function parsePageRange(fromRaw: string, toRaw: string): PageRangeResult {
  const fromText = fromRaw.trim()
  const toText = toRaw.trim()

  if (!fromText && !toText) {
    return {ok: true, range: null, message: ''}
  }

  let from = 1
  if (fromText) from = Number(fromText)

  let to = null
  if (toText) to = Number(toText)

  if (!Number.isInteger(from) || from < 1) {
    return {
      ok: false,
      range: null,
      message: 'First page must be a whole number, 1 or more.',
    }
  }

  if (to !== null && (!Number.isInteger(to) || to < 1)) {
    return {
      ok: false,
      range: null,
      message: 'Last page must be a whole number, 1 or more.',
    }
  }

  if (to !== null && to < from) {
    return {
      ok: false,
      range: null,
      message: "Last page can't be before page " + from + '.',
    }
  }

  return {ok: true, range: {from, to}, message: ''}
}

export type QuestionCountResult = {
  ok: boolean
  count: number | null
  message: string
}

export function parseQuestionCount(raw: string): QuestionCountResult {
  const text = raw.trim()
  if (!text) return {ok: true, count: null, message: ''}

  const count = Number(text)

  if (!Number.isInteger(count) || count < 1) {
    return {
      ok: false,
      count: null,
      message: 'Question count must be a whole number, 1 or more.',
    }
  }

  return {ok: true, count, message: ''}
}

export function pageInRange(pageNumber: number, range: PageRange | null) {
  if (!range) return true
  if (pageNumber < range.from) return false
  if (range.to === null) return true
  return pageNumber <= range.to
}

export function countInRange(totalPages: number, range: PageRange | null) {
  if (!range) return totalPages

  let last = totalPages
  if (range.to !== null && range.to < totalPages) last = range.to

  let count = last - range.from + 1
  if (count < 0) return 0
  return count
}

export function describePageRange(range: PageRange | null) {
  if (!range) return 'every page'
  if (range.to === null) return 'page ' + range.from + ' onwards'
  if (range.to === range.from) return 'page ' + range.from
  return 'pages ' + range.from + '–' + range.to
}

export function destination(
  id: string,
  worksheet: {status: string; questionCount: number; markedCount: number},
) {
  if (
    worksheet.status === 'uploading' ||
    worksheet.status === 'queued' ||
    worksheet.status === 'processing'
  ) {
    return {href: '/worksheets/' + id + '/status', cta: 'Processing'}
  }

  if (worksheet.status === 'awaiting_review') {
    if (worksheet.questionCount > 0) {
      return {href: '/worksheets/' + id + '/check', cta: 'Check questions'}
    }

    return {href: '/worksheets/' + id + '/edit', cta: 'Add questions'}
  }

  if (worksheet.status === 'failed') {
    return {href: '/worksheets/' + id + '/status', cta: 'See what happened'}
  }

  let cta = 'Mark answers'
  if (worksheet.markedCount > 0) cta = 'See your marks'

  return {href: '/worksheets/' + id + '/markup', cta: cta}
}

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2'
export const EMBEDDING_DIMENSIONS = 384

export const EMBEDDING_INPUT_LIMIT = 2000

export const MIN_ATTEMPTS = 5

export const SAMPLE_WORKSHEETS = [
  {slug: 'algebra-25', title: 'Algebra practice A', questions: 25, pages: 2, seconds: 40},
  {slug: 'algebra-10', title: 'Algebra practice B', questions: 10, pages: 1, seconds: 20},
  {slug: 'algebra-5', title: 'Algebra warm-up', questions: 5, pages: 1, seconds: 10},
]

export function findSample(slug: string | undefined) {
  for (let sample of SAMPLE_WORKSHEETS) {
    if (sample.slug === slug) return sample
  }

  return undefined
}
