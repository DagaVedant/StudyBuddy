import type { BBox } from '@/lib/db/schema'

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
