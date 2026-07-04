import type * as PdfjsModule from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'

import type { TextLine } from '@/lib/db/schema'
import { RASTER_DPI, RASTER_MAX_EDGE } from '@/lib/upload/limits'
import { pageInRange, type PageRange } from '@/lib/upload/page-range'

/**
 * pdf.js is deliberately NOT bundled. Both files are served from /public,
 * copied there by scripts/copy-pdf-worker.mjs. Two verified failures forced
 * this (see that script's header): Turbopack can't resolve the worker URL
 * specifier, and its re-bundled main module hangs forever inside
 * `page.render()` against the stock worker. The unbundled pair works.
 *
 * The `new Function` indirection stops the bundler from statically analyzing
 * the import and pulling the module into its graph.
 */
const runtimeImport = new Function('url', 'return import(url)') as (
  url: string,
) => Promise<typeof PdfjsModule>

let pdfjsPromise: Promise<typeof PdfjsModule> | null = null

async function getPdfjs(): Promise<typeof PdfjsModule> {
  pdfjsPromise ??= runtimeImport('/pdf.min.mjs').then((mod) => {
    mod.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'
    return mod
  })
  return pdfjsPromise
}

/** pdf.js viewports are in CSS points, 72 to the inch. */
const PDF_POINTS_PER_INCH = 72

export interface RasterPage {
  pageNumber: number
  blob: Blob
  width: number
  height: number
  /** Text layer embedded in the PDF, empty for scans, photos, and images. */
  embeddedText: string
  /** Line geometry in page-image pixels, for drag-to-fill in the editor. */
  embeddedLines: TextLine[]
}

/**
 * Groups pdf.js text items into lines in canvas pixel space. Items arrive as
 * fragments with a baseline origin, so they're bucketed by baseline and then
 * ordered left to right.
 */
function toTextLines(
  pdfjs: typeof PdfjsModule,
  items: TextItem[],
  viewport: PdfjsModule.PageViewport,
  scale: number,
): TextLine[] {
  interface Fragment {
    text: string
    x0: number
    y0: number
    x1: number
    y1: number
    baseline: number
  }

  const fragments: Fragment[] = []

  for (const item of items) {
    if (!item.str.trim()) continue

    const t = pdfjs.Util.transform(viewport.transform, item.transform)
    const x0 = t[4]
    const baseline = t[5]
    const height = Math.hypot(t[2], t[3]) || item.height * scale
    const width = item.width * scale

    fragments.push({
      text: item.str,
      x0,
      y0: baseline - height,
      x1: x0 + width,
      y1: baseline,
      baseline,
    })
  }

  fragments.sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0)

  const lines: TextLine[] = []
  let current: Fragment[] = []

  const flush = () => {
    if (current.length === 0) return
    const ordered = [...current].sort((a, b) => a.x0 - b.x0)
    const text = ordered
      .map((fragment) => fragment.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text) {
      lines.push({
        text,
        bbox: [
          Math.min(...ordered.map((f) => f.x0)),
          Math.min(...ordered.map((f) => f.y0)),
          Math.max(...ordered.map((f) => f.x1)),
          Math.max(...ordered.map((f) => f.y1)),
        ],
      })
    }
    current = []
  }

  for (const fragment of fragments) {
    const previous = current.at(-1)
    const tolerance = Math.max((fragment.y1 - fragment.y0) * 0.6, 2)
    if (previous && Math.abs(fragment.baseline - previous.baseline) > tolerance) {
      flush()
    }
    current.push(fragment)
  }
  flush()

  return lines
}

export interface RasterProgress {
  page: number
  total: number
}

export interface RasterizeOptions {
  /** Pages already contributed by earlier files, so the range is document-wide. */
  offset?: number
  range?: PageRange | null
}

export interface RasterizedPdf {
  pages: RasterPage[]
  /** Every page in the file, including the ones the range skipped. */
  totalPages: number
}

async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  // WebP is dramatically smaller than PNG on scanned text and loses nothing
  // OCR or a vision model cares about at this quality.
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', 0.9),
  )
  if (blob) return blob

  const fallback = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.92),
  )
  if (!fallback) throw new Error('This browser could not encode the page image.')
  return fallback
}

/**
 * Rasterizes a PDF entirely in the browser (spec §5.2 step 2). Nothing
 * downstream ever parses a PDF, which keeps that attack surface off the server
 * and off the operator's GPU machine.
 */
export async function rasterizePdf(
  file: File,
  onProgress?: (progress: RasterProgress) => void,
  options: RasterizeOptions = {},
): Promise<RasterizedPdf> {
  const { offset = 0, range = null } = options

  const pdfjs = await getPdfjs()
  const data = await file.arrayBuffer()

  // v6 hangs teardown off the loading task, not the document proxy.
  const loadingTask = pdfjs.getDocument({ data })
  const pdf = await loadingTask.promise

  const pages: RasterPage[] = []

  // The bar counts pages that will actually be rendered, not pages in the
  // file — a 112-page PDF trimmed to 59 is 59 units of work, and a bar that
  // stops at 59/112 looks like a failure.
  let plannedTotal = 0
  for (let n = 1; n <= pdf.numPages; n += 1) {
    if (pageInRange(offset + n, range)) plannedTotal += 1
  }

  let rendered = 0

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      /*
       * Skipped before getPage, so an excluded page is never decoded, never
       * rendered to a canvas, and never encoded. That is the entire point of
       * putting the range here rather than filtering later.
       */
      if (!pageInRange(offset + pageNumber, range)) continue

      const page = await pdf.getPage(pageNumber)

      let scale = RASTER_DPI / PDF_POINTS_PER_INCH
      const base = page.getViewport({ scale })
      const longestEdge = Math.max(base.width, base.height)
      if (longestEdge > RASTER_MAX_EDGE) {
        scale *= RASTER_MAX_EDGE / longestEdge
      }

      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)

      // `intent: 'print'` is load-bearing: the default display intent chunks
      // its work on requestAnimationFrame, which Chrome suspends entirely in
      // hidden tabs — so rendering stalls the moment the student switches
      // tabs mid-upload. Print intent renders without rAF scheduling.
      await page.render({ canvas, viewport, intent: 'print' }).promise

      const [blob, textContent] = await Promise.all([
        canvasToBlob(canvas),
        page.getTextContent(),
      ])

      const textItems = textContent.items.filter(
        (item): item is TextItem => 'str' in item,
      )

      const embeddedLines = toTextLines(pdfjs, textItems, viewport, scale)
      const embeddedText = embeddedLines.map((line) => line.text).join('\n')

      pages.push({
        // The page's number in its own document, not its position in what was
        // kept. A student who extracts pages 60-112 should see "page 60", not
        // "page 1" — and nothing downstream requires these to start at 1.
        pageNumber: offset + pageNumber,
        blob,
        width: canvas.width,
        height: canvas.height,
        embeddedText,
        embeddedLines,
      })

      // Release the backing bitmap before the next page allocates one.
      canvas.width = 0
      canvas.height = 0

      page.cleanup()
      rendered += 1
      onProgress?.({ page: rendered, total: plannedTotal })
    }
  } finally {
    await loadingTask.destroy()
  }

  return { pages, totalPages: pdf.numPages }
}

/** Normalizes a photo or image upload into the same shape as a PDF page. */
export async function rasterizeImage(
  file: File,
  pageNumber: number,
): Promise<RasterPage> {
  const bitmap = await createImageBitmap(file)

  try {
    const longestEdge = Math.max(bitmap.width, bitmap.height)
    const scale = longestEdge > RASTER_MAX_EDGE ? RASTER_MAX_EDGE / longestEdge : 1

    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)

    const context = canvas.getContext('2d')
    if (!context) throw new Error('This browser could not process the image.')
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

    const blob = await canvasToBlob(canvas)
    const { width, height } = canvas

    canvas.width = 0
    canvas.height = 0

    return { pageNumber, blob, width, height, embeddedText: '', embeddedLines: [] }
  } finally {
    bitmap.close()
  }
}

/**
 * A born-digital PDF carries a usable text layer, so OCR can be skipped
 * entirely — it's both exact and free. Scans and photos land well under this.
 */
export function hasUsableTextLayer(pages: RasterPage[]): boolean {
  if (pages.length === 0) return false
  const totalChars = pages.reduce((sum, page) => sum + page.embeddedText.length, 0)
  return totalChars / pages.length >= 120
}
