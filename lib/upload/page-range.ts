/**
 * Optional page range for an upload (spec §5.2 step 2).
 *
 * Practice material routinely bundles a test with its answer key and a full
 * explanations section — one real SHSAT form is 59 pages of test followed by
 * 53 pages of rationales. Extracting all 112 produced 81 items that were not
 * questions and cost the GPU an extra 53 pages of work.
 *
 * Filtering afterwards cannot fix that: the pages have already been rendered,
 * uploaded, read, and processed. So the range is applied at the front, before
 * rasterization, and out-of-range pages are never touched at all.
 */

export interface PageRange {
  from: number
  /** null means "to the last page". */
  to: number | null
}

export type PageRangeResult =
  | { ok: true; range: PageRange | null }
  | { ok: false; message: string }

/**
 * Reads the two boxes on the upload screen. Both empty means every page, which
 * is the default and must stay the zero-effort path.
 */
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

export function pageInRange(pageNumber: number, range: PageRange | null): boolean {
  if (!range) return true
  if (pageNumber < range.from) return false
  return range.to === null || pageNumber <= range.to
}

/**
 * How many of a document's pages the range actually selects — used for the
 * progress bar's denominator, so it counts what will be rendered rather than
 * what was in the file.
 */
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
