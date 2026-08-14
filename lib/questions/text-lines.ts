import type { BBox, TextLine } from '@/lib/db/schema'

/**
 * A page's words, at the precision they are actually compared at.
 *
 * pdf.js hands back transformed floats, so a line's box serializes as
 * `[56.79999999999995, 712.3200000000002, …]`: four numbers of eighteen
 * characters, on up to 4000 lines a page. `textInside` (page-canvas.tsx) only
 * asks which side of a dragged box the centre of a line falls on, in whole
 * page pixels, and the drag it compares against comes from a fingertip.
 * Everything past the decimal point is payload and nothing else.
 *
 * Shared between the review page's initial render (app/(app)/worksheets/[id]/
 * review/page.tsx, page one only) and the per-page route it fetches the rest
 * from (app/api/worksheets/[id]/pages/[pageId]/lines/route.ts), so a paper
 * with page one open reads the exact bytes it would have gotten from a fetch.
 */
export function roundLines(lines: TextLine[] | null): TextLine[] {
  return (lines ?? []).map((line) => {
    const bbox: BBox = [
      Math.round(line.bbox[0]),
      Math.round(line.bbox[1]),
      Math.round(line.bbox[2]),
      Math.round(line.bbox[3]),
    ]
    return { text: line.text, bbox }
  })
}
