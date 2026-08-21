import {
  describePageRange,
  MAX_SOURCE_BYTES,
  pageInRange,
  type PageRange,
} from '@/lib/upload'

import {
  hasUsableTextLayer,
  rasterizeImage,
  rasterizePdf,
  type RasterPage,
} from './rasterize'
import {fetchJson, throwIfCancelled} from './http'
import {ocrPage, preloadOcr} from './rasterize'

export type IngestStage =
  | 'reading'
  | 'rasterizing'
  | 'uploading'
  | 'ocr'
  | 'finishing'
  | 'done'

export interface IngestProgress {
  stage: IngestStage
  completed: number
  total: number
  detail: string
}

export interface IngestOptions {
  files: File[]
  title: string
  subjectHint?: string | null

  pageRange?: PageRange | null

  expectedQuestionCount?: number | null
  onProgress: (progress: IngestProgress) => void
  onWorksheetCreated?: (worksheetId: string) => void
  signal?: AbortSignal
}

export interface IngestResult {
  worksheetId: string
  pageCount: number
  next: string
}

class IngestError extends Error {}

const assertNotAborted = throwIfCancelled

async function expectOk(response: Response): Promise<unknown> {
  if (response.ok) return response.json()

  const body = (await response.json().catch(() => null)) as {error?: string} | null
  throw new IngestError(body?.error ?? `Request failed (${response.status}).`)
}

export async function ingestWorksheet({
  files,
  title,
  subjectHint,
  pageRange = null,
  expectedQuestionCount = null,
  onProgress,
  onWorksheetCreated,
  signal,
}: IngestOptions): Promise<IngestResult> {
  if (files.length === 0) throw new IngestError('Pick at least one file.')

  const oversized = files.find((file) => file.size > MAX_SOURCE_BYTES)
  if (oversized) {
    throw new IngestError(`"${oversized.name}" is too large to upload.`)
  }

  onProgress({stage: 'reading', completed: 0, total: 1, detail: 'Reading files'})

  const pdfs = files.filter((file) => file.type === 'application/pdf')
  const images = files.filter((file) => file.type !== 'application/pdf')

  const pages: RasterPage[] = []
  let sawPdf = false

  let offset = 0

  for (const file of pdfs) {
    assertNotAborted(signal)
    sawPdf = true

    const rendered = await rasterizePdf(
      file,
      ({page, total}) => {
        onProgress({
          stage: 'rasterizing',
          completed: page,
          total,
          detail: `Rendering ${file.name}`,
        })
      },
      {offset, range: pageRange, signal},
    )

    pages.push(...rendered.pages)
    offset += rendered.totalPages
  }

  for (const file of images) {
    assertNotAborted(signal)
    offset += 1
    if (!pageInRange(offset, pageRange)) continue

    onProgress({
      stage: 'rasterizing',
      completed: pages.length + 1,
      total: pages.length + 1,
      detail: `Processing ${file.name}`,
    })
    pages.push(await rasterizeImage(file, offset, signal))
  }

  if (pages.length === 0) {
    throw new IngestError(
      pageRange
        ? `No pages in ${describePageRange(pageRange)}. That upload has ${offset} ${offset === 1 ? 'page' : 'pages'}.`
        : 'Nothing readable in those files.',
    )
  }

  const digital = sawPdf && hasUsableTextLayer(pages)
  const sourceType = sawPdf
    ? digital
      ? 'pdf_digital'
      : 'pdf_scanned'
    : images.some((file) => file.type === 'image/heic' || file.type === 'image/heif')
      ? 'photo'
      : 'image'

  if (!digital) preloadOcr()

  assertNotAborted(signal)

  const created = (await expectOk(
    await fetchJson('/api/worksheets', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        title,
        sourceType,
        subjectHint: subjectHint || null,
        pageCount: pages.length,
        expectedQuestionCount,
      }),
      signal,
    }),
  )) as {worksheetId: string}

  const worksheetId = created.worksheetId
  onWorksheetCreated?.(worksheetId)

  const pageIds: string[] = []

  for (const [index, page] of pages.entries()) {
    assertNotAborted(signal)
    onProgress({
      stage: 'uploading',
      completed: index + 1,
      total: pages.length,
      detail: `Uploading page ${page.pageNumber}`,
    })

    const form = new FormData()
    form.set('image', page.blob, `page-${page.pageNumber}.webp`)
    form.set('pageNumber', String(page.pageNumber))
    form.set('width', String(page.width))
    form.set('height', String(page.height))

    const uploaded = (await expectOk(
      await fetchJson(`/api/worksheets/${worksheetId}/pages`, {
        method: 'POST',
        body: form,
        signal,
      }),
    )) as {pageId: string}

    pageIds.push(uploaded.pageId)
  }

  for (const [index, page] of pages.entries()) {
    assertNotAborted(signal)
    onProgress({
      stage: 'ocr',
      completed: index + 1,
      total: pages.length,
      detail: digital
        ? `Reading text from page ${page.pageNumber}`
        : `Recognizing text on page ${page.pageNumber}`,
    })

    const {text, lines} = digital
      ? {text: page.embeddedText, lines: page.embeddedLines}
      : await ocrPage(page.blob, signal)

    await expectOk(
      await fetchJson(`/api/worksheets/${worksheetId}/pages`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          pageId: pageIds[index],
          ocrText: text.slice(0, 200_000),
          ocrEngine: digital ? 'pdf_text' : 'tesseract',
          textLines: lines.slice(0, 4000),
        }),
        signal,
      }),
    )
  }

  onProgress({
    stage: 'finishing',
    completed: 1,
    total: 1,
    detail: 'Wrapping up',
  })

  const finished = (await expectOk(
    await fetchJson(`/api/worksheets/${worksheetId}/complete`, {
      method: 'POST',
      signal,
    }),
  )) as {next: string}

  onProgress({stage: 'done', completed: 1, total: 1, detail: 'Done'})

  return {worksheetId, pageCount: pages.length, next: finished.next}
}

export interface PageImage {
  image: Uint8Array
  mediaType: string
}

export async function toPngBytes(blob: Blob): Promise<PageImage> {
  if (blob.type === 'image/png' || blob.type === 'image/jpeg') {
    return {image: new Uint8Array(await blob.arrayBuffer()), mediaType: blob.type}
  }

  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height

    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('This browser would not give us a canvas to convert the page on.')
    }
    context.drawImage(bitmap, 0, 0)

    const png = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    )
    if (!png) throw new Error('The page image could not be converted to PNG.')

    return {image: new Uint8Array(await png.arrayBuffer()), mediaType: 'image/png'}
  } finally {
    bitmap.close()
  }
}

export async function fetchPageImage(imageKey: string): Promise<PageImage> {
  const response = await fetch(`/api/files/${imageKey}`)
  if (!response.ok) throw new Error('Could not load the page image.')

  return toPngBytes(await response.blob())
}
