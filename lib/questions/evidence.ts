import type { BBox } from '@/lib/db/schema'

/** The page, and where on it the question sits, ready to be cropped to. */
export interface QuestionEvidence {
  src: string
  width: number
  height: number
  bbox: BBox
}

export interface EvidencePage {
  imageKey: string
  width: number | null
  height: number | null
}

/**
 * The scan a question can be shown against, or null if none can be placed.
 *
 * The bbox is in the page image's own pixels, so a page that never recorded
 * its size gives nothing to measure it against and the crop would land
 * somewhere arbitrary. A box with no area, or one that falls off the page
 * entirely, is the reader guessing; both come back from extraction and neither
 * can be cropped to. Every one of these degrades to no image, because a crop
 * of the wrong part of the page is worse than none on a screen whose whole job
 * is comparing against the paper.
 *
 * Lived in the verify route until the review screen needed the same thing.
 * Nothing crops a figure anywhere in the pipeline, so a geometry or graph
 * question reached spaced repetition as text with no picture, which is not a
 * question anyone can answer. The crop the verify screen already does is the
 * whole fix: the bytes are on the page image and the box is already stored.
 */
export function evidenceFor(
  bbox: BBox | null,
  page: EvidencePage | undefined,
): QuestionEvidence | null {
  if (!bbox || !page?.width || !page.height) return null

  const [x0, y0, x1, y1] = bbox
  if (x1 <= x0 || y1 <= y0) return null
  if (x0 >= page.width || y0 >= page.height || x1 <= 0 || y1 <= 0) return null

  return {
    src: `/api/files/${page.imageKey}`,
    width: page.width,
    height: page.height,
    bbox,
  }
}
