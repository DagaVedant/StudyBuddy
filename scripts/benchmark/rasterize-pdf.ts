import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createCanvas } from '@napi-rs/canvas'
import sharp from 'sharp'

import { RASTER_DPI, RASTER_MAX_EDGE } from '../../lib/upload/limits'

const PDF_POINTS_PER_INCH = 72

export interface RasterizedPage {
  pageNumber: number
  file: string
  width: number
  height: number
  /** The PDF's own text layer, which production also feeds the model. */
  text: string
}

/**
 * Renders pages to disk at the same DPI, edge cap and encoding the browser
 * pipeline uses, so the models are scored on the images production would
 * actually hand them rather than on a cleaner or coarser render.
 */
export async function rasterizePdfPages(
  pdfPath: string,
  outDir: string,
  fromPage: number,
  toPage: number,
): Promise<RasterizedPage[]> {
  const { readFile } = await import('node:fs/promises')
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

  await mkdir(outDir, { recursive: true })

  const data = new Uint8Array(await readFile(pdfPath))
  const doc = await pdfjs.getDocument({ data }).promise

  const last = Math.min(toPage, doc.numPages)
  const pages: RasterizedPage[] = []

  for (let pageNumber = fromPage; pageNumber <= last; pageNumber += 1) {
    const page = await doc.getPage(pageNumber)

    let scale = RASTER_DPI / PDF_POINTS_PER_INCH
    const base = page.getViewport({ scale })
    const longestEdge = Math.max(base.width, base.height)
    if (longestEdge > RASTER_MAX_EDGE) scale *= RASTER_MAX_EDGE / longestEdge

    const viewport = page.getViewport({ scale })
    const width = Math.floor(viewport.width)
    const height = Math.floor(viewport.height)

    const canvas = createCanvas(width, height)
    const context = canvas.getContext('2d')

    // pdf.js renders transparent where the page is blank; the browser path
    // composites onto a white canvas, so match that or the model sees black.
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)

    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
      intent: 'print',
    } as never).promise

    const webp = await sharp(canvas.toBuffer('image/png')).webp({ quality: 90 }).toBuffer()

    const file = join(outDir, `page-${String(pageNumber).padStart(3, '0')}.webp`)
    await writeFile(file, webp)

    const content = await page.getTextContent()
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()

    pages.push({ pageNumber, file, width, height, text })
    page.cleanup()
  }

  return pages
}
