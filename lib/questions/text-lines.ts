import type { BBox, TextLine } from '@/lib/db/schema'

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
