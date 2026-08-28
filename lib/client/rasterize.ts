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

function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = runtimeImport('/pdf.min.mjs').then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'
      return mod
    })
  }

  return pdfjsPromise
}

const PDF_POINTS_PER_INCH = 72

export type RasterPage = {
  pageNumber: number
  blob: Blob
  width: number
  height: number
  embeddedText: string
  embeddedLines: TextLine[]
}

export type RasterProgress = {
  page: number
  total: number
}

export type RasterizeOptions = {
  offset?: number
  range?: PageRange | null
  signal?: AbortSignal
}

export type RasterizedPdf = {
  pages: RasterPage[]
  totalPages: number
}

type Fragment = {
  text: string
  x0: number
  y0: number
  x1: number
  y1: number
  baseline: number
}

function lineFrom(fragments: Fragment[]): TextLine | null {
  let ordered = fragments.slice()
  ordered.sort(function (a, b) {
    return a.x0 - b.x0
  })

  let words = []
  for (let fragment of ordered) words.push(fragment.text)

  let text = words.join(' ').replace(/\s+/g, ' ').trim()
  if (!text) return null

  let minX = ordered[0].x0
  let minY = ordered[0].y0
  let maxX = ordered[0].x1
  let maxY = ordered[0].y1

  for (let fragment of ordered) {
    if (fragment.x0 < minX) minX = fragment.x0
    if (fragment.y0 < minY) minY = fragment.y0
    if (fragment.x1 > maxX) maxX = fragment.x1
    if (fragment.y1 > maxY) maxY = fragment.y1
  }

  return {text: text, bbox: [minX, minY, maxX, maxY]}
}

function toTextLines(
  pdfjs: typeof PdfjsModule,
  items: TextItem[],
  viewport: PdfjsModule.PageViewport,
  scale: number,
) {
  let fragments: Fragment[] = []

  for (let item of items) {
    if (!item.str.trim()) continue

    let t = pdfjs.Util.transform(viewport.transform, item.transform)
    let x0 = t[4]
    let baseline = t[5]

    let height = Math.hypot(t[2], t[3])
    if (!height) height = item.height * scale

    let width = item.width * scale

    fragments.push({
      text: item.str,
      x0: x0,
      y0: baseline - height,
      x1: x0 + width,
      y1: baseline,
      baseline: baseline,
    })
  }

  fragments.sort(function (a, b) {
    if (a.baseline !== b.baseline) return a.baseline - b.baseline
    return a.x0 - b.x0
  })

  let lines: TextLine[] = []
  let current: Fragment[] = []

  for (let fragment of fragments) {
    let previous = current[current.length - 1]

    let tolerance = (fragment.y1 - fragment.y0) * 0.6
    if (tolerance < 2) tolerance = 2

    if (previous && Math.abs(fragment.baseline - previous.baseline) > tolerance) {
      let line = lineFrom(current)
      if (line) lines.push(line)
      current = []
    }

    current.push(fragment)
  }

  if (current.length > 0) {
    let line = lineFrom(current)
    if (line) lines.push(line)
  }

  return lines
}

async function canvasToBlob(canvas: HTMLCanvasElement) {
  const webp = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/webp', 0.9)
  })

  if (webp) return webp

  const jpeg = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', 0.92)
  })

  if (!jpeg) throw new Error('This browser could not encode the page image.')
  return jpeg
}

export async function rasterizePdf(
  file: File,
  onProgress?: (progress: RasterProgress) => void,
  options: RasterizeOptions = {},
): Promise<RasterizedPdf> {
  let offset = 0
  if (options.offset) offset = options.offset

  let range: PageRange | null = null
  if (options.range) range = options.range

  const signal = options.signal

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
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      if (!pageInRange(offset + pageNumber, range)) continue

      throwIfCancelled(signal)

      const page = await pdf.getPage(pageNumber)

      let scale = RASTER_DPI / PDF_POINTS_PER_INCH
      const base = page.getViewport({scale})

      let longestEdge = base.width
      if (base.height > longestEdge) longestEdge = base.height

      if (longestEdge > RASTER_MAX_EDGE) {
        scale = scale * (RASTER_MAX_EDGE / longestEdge)
      }

      const viewport = page.getViewport({scale})
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)

      const renderTask = page.render({canvas, viewport, intent: 'print'})

      function cancelRender() {
        renderTask.cancel()
      }

      if (signal) signal.addEventListener('abort', cancelRender, {once: true})

      try {
        await renderTask.promise
      } catch (cause) {
        throwIfCancelled(signal)
        throw cause
      } finally {
        if (signal) signal.removeEventListener('abort', cancelRender)
      }

      const blob = await canvasToBlob(canvas)
      const textContent = await page.getTextContent()

      let textItems: TextItem[] = []
      for (let item of textContent.items) {
        if ('str' in item) textItems.push(item)
      }

      const embeddedLines = toTextLines(pdfjs, textItems, viewport, scale)

      let texts = []
      for (let line of embeddedLines) texts.push(line.text)

      pages.push({
        pageNumber: offset + pageNumber,
        blob: blob,
        width: canvas.width,
        height: canvas.height,
        embeddedText: texts.join('\n'),
        embeddedLines: embeddedLines,
      })

      canvas.width = 0
      canvas.height = 0

      page.cleanup()
      rendered = rendered + 1

      if (onProgress) onProgress({page: rendered, total: plannedTotal})
    }
  } finally {
    await loadingTask.destroy()
  }

  return {pages: pages, totalPages: pdf.numPages}
}

export async function rasterizeImage(
  file: File,
  pageNumber: number,
  signal?: AbortSignal,
): Promise<RasterPage> {
  throwIfCancelled(signal)

  const bitmap = await createImageBitmap(file, {imageOrientation: 'from-image'})

  try {
    let longestEdge = bitmap.width
    if (bitmap.height > longestEdge) longestEdge = bitmap.height

    let scale = 1
    if (longestEdge > RASTER_MAX_EDGE) scale = RASTER_MAX_EDGE / longestEdge

    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)

    const context = canvas.getContext('2d')
    if (!context) throw new Error('This browser could not process the image.')

    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

    const blob = await canvasToBlob(canvas)
    const width = canvas.width
    const height = canvas.height

    canvas.width = 0
    canvas.height = 0

    return {
      pageNumber: pageNumber,
      blob: blob,
      width: width,
      height: height,
      embeddedText: '',
      embeddedLines: [],
    }
  } finally {
    bitmap.close()
  }
}

const MIN_CHARS_PER_PAGE = 120

export function hasUsableTextLayer(pages: RasterPage[]) {
  if (pages.length === 0) return false

  let totalChars = 0
  for (let page of pages) totalChars = totalChars + page.embeddedText.length

  return totalChars / pages.length >= MIN_CHARS_PER_PAGE
}

let workerPromise: Promise<Worker> | null = null

function getWorker() {
  if (!workerPromise) workerPromise = createWorker('eng')
  return workerPromise
}

export function preloadOcr() {
  getWorker().catch(() => {
    workerPromise = null
  })
}

export type OcrResult = {
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
    if (signal && signal.aborted) terminateOcr().catch(() => {})
    throw cause
  }

  const data = recognized.data

  let blocks = data.blocks
  if (!blocks) blocks = []

  const lines: TextLine[] = []

  for (let block of blocks) {
    let paragraphs = block.paragraphs
    if (!paragraphs) paragraphs = []

    for (let paragraph of paragraphs) {
      let paragraphLines = paragraph.lines
      if (!paragraphLines) paragraphLines = []

      for (let line of paragraphLines) {
        let text = line.text.trim()
        if (!text) continue

        lines.push({
          text: text,
          bbox: [line.bbox.x0, line.bbox.y0, line.bbox.x1, line.bbox.y1],
        })
      }
    }
  }

  return {text: data.text.replace(/\s+\n/g, '\n').trim(), lines: lines}
}

export async function terminateOcr() {
  if (!workerPromise) return

  const worker = await workerPromise.catch(() => null)
  workerPromise = null

  if (worker) await worker.terminate()
}
