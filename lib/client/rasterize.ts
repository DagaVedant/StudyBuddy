import * as PdfjsModule from 'pdfjs-dist'
import {createWorker, type Worker} from 'tesseract.js'
import {type TextItem} from 'pdfjs-dist/types/src/display/api'

import {
  countInRange,
  pageInRange,
  type PageRange,
  RASTER_DPI,
  RASTER_MAX_EDGE,
} from '@/lib/upload'
import {type TextLine} from '@/lib/schema'

import {throwIfCancelled, untilCancelled} from './http'

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

const PDF_POINTS_PER_INCH = 72

export interface RasterPage {
  pageNumber: number
  blob: Blob
  width: number
  height: number
  embeddedText: string
  embeddedLines: TextLine[]
}

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
          Math.min(...ordered.map((f) => f.x0)), Math.min(...ordered.map((f) => f.y0)),
          Math.max(...ordered.map((f) => f.x1)), Math.max(...ordered.map((f) => f.y1)),
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
  offset?: number
  range?: PageRange | null
  signal?: AbortSignal
}

export interface RasterizedPdf {
  pages: RasterPage[]
  totalPages: number
}

async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
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

export async function rasterizePdf(
  file: File,
  onProgress?: (progress: RasterProgress) => void,
  options: RasterizeOptions = {},
): Promise<RasterizedPdf> {
  const {offset = 0, range = null, signal} = options

  throwIfCancelled(signal)

  const pdfjs = await getPdfjs()
  const data = await file.arrayBuffer()

  const loadingTask = pdfjs.getDocument({data})
  const pdf = await loadingTask.promise

  const pages: RasterPage[] = []

  const plannedTotal =
    countInRange(offset + pdf.numPages, range) - countInRange(offset, range)

  let rendered = 0

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      if (!pageInRange(offset + pageNumber, range)) continue

      throwIfCancelled(signal)

      const page = await pdf.getPage(pageNumber)

      let scale = RASTER_DPI / PDF_POINTS_PER_INCH
      const base = page.getViewport({scale})
      const longestEdge = Math.max(base.width, base.height)
      if (longestEdge > RASTER_MAX_EDGE) {
        scale *= RASTER_MAX_EDGE / longestEdge
      }

      const viewport = page.getViewport({scale})
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)

      const renderTask = page.render({canvas, viewport, intent: 'print'})
      const cancelRender = () => renderTask.cancel()
      signal?.addEventListener('abort', cancelRender, {once: true})

      try {
        await renderTask.promise
      } catch (cause) {
        throwIfCancelled(signal)
        throw cause
      } finally {
        signal?.removeEventListener('abort', cancelRender)
      }

      const [blob, textContent] = await Promise.all([
        canvasToBlob(canvas), page.getTextContent(),
      ])

      const textItems = textContent.items.filter(
        (item): item is TextItem => 'str' in item,
      )

      const embeddedLines = toTextLines(pdfjs, textItems, viewport, scale)
      const embeddedText = embeddedLines.map((line) => line.text).join('\n')

      pages.push({
        pageNumber: offset + pageNumber,
        blob,
        width: canvas.width,
        height: canvas.height,
        embeddedText,
        embeddedLines,
      })

      canvas.width = 0
      canvas.height = 0

      page.cleanup()
      rendered += 1
      onProgress?.({page: rendered, total: plannedTotal})
    }
  } finally {
    await loadingTask.destroy()
  }

  return {pages, totalPages: pdf.numPages}
}

export async function rasterizeImage(
  file: File,
  pageNumber: number,
  signal?: AbortSignal,
): Promise<RasterPage> {
  throwIfCancelled(signal)

  // Phone cameras store portrait shots as landscape pixels plus an EXIF
  // orientation tag. createImageBitmap ignores that tag by default, and the
  // canvas re-encode below drops it, so without this the rotation is lost for
  // good and every page comes out sideways.
  const bitmap = await createImageBitmap(file, {imageOrientation: 'from-image'})

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
    const {width, height} = canvas

    canvas.width = 0
    canvas.height = 0

    return {pageNumber, blob, width, height, embeddedText: '', embeddedLines: []}
  } finally {
    bitmap.close()
  }
}

const MIN_CHARS_PER_PAGE = 120

export function hasUsableTextLayer(pages: RasterPage[]): boolean {
  if (pages.length === 0) return false
  const totalChars = pages.reduce((sum, page) => sum + page.embeddedText.length, 0)
  return totalChars / pages.length >= MIN_CHARS_PER_PAGE
}

let workerPromise: Promise<Worker> | null = null

async function getWorker(): Promise<Worker> {
  workerPromise ??= createWorker('eng')
  return workerPromise
}

export function preloadOcr(): void {
  void getWorker().catch(() => {
    workerPromise = null
  })
}

export interface OcrResult {
  text: string
  lines: TextLine[]
}

export async function ocrPage(image: Blob, signal?: AbortSignal): Promise<OcrResult> {
  throwIfCancelled(signal)

  const worker = await untilCancelled(getWorker(), signal)

  let recognized
  try {
    recognized = await untilCancelled(
      worker.recognize(image, {}, {text: true, blocks: true}),
      signal,
    )
  } catch (cause) {
    if (signal?.aborted) terminateOcr().catch(() => {})
    throw cause
  }

  const {data} = recognized

  const lines: TextLine[] = []
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const text = line.text.trim()
        if (!text) continue
        lines.push({text, bbox: [line.bbox.x0, line.bbox.y0, line.bbox.x1, line.bbox.y1]})
      }
    }
  }

  return {text: data.text.replace(/\s+\n/g, '\n').trim(), lines}
}

export async function terminateOcr(): Promise<void> {
  if (!workerPromise) return
  const worker = await workerPromise.catch(() => null)
  workerPromise = null
  await worker?.terminate()
}
