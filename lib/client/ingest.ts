import { ocrPage, preloadOcr } from './ocr'
import {
  hasUsableTextLayer,
  rasterizeImage,
  rasterizePdf,
  type RasterPage,
} from './rasterize'

import { MAX_SOURCE_BYTES } from '@/lib/upload/limits'

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
  onProgress: (progress: IngestProgress) => void
  signal?: AbortSignal
}

export interface IngestResult {
  worksheetId: string
  pageCount: number
  next: string
}

class IngestError extends Error {}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new IngestError('Upload cancelled.')
}

async function expectOk(response: Response): Promise<unknown> {
  if (response.ok) return response.json()

  const body = (await response.json().catch(() => null)) as { error?: string } | null
  throw new IngestError(body?.error ?? `Request failed (${response.status}).`)
}

/**
 * The whole Tier A ingest path, driven from the browser (spec §5.2):
 * rasterize -> upload page images -> text layer -> hand off to review.
 *
 * The server never sees the original file. For born-digital PDFs the embedded
 * text layer is used directly and OCR is skipped entirely.
 */
export async function ingestWorksheet({
  files,
  title,
  subjectHint,
  onProgress,
  signal,
}: IngestOptions): Promise<IngestResult> {
  if (files.length === 0) throw new IngestError('Pick at least one file.')

  const oversized = files.find((file) => file.size > MAX_SOURCE_BYTES)
  if (oversized) {
    throw new IngestError(`"${oversized.name}" is too large to upload.`)
  }

  onProgress({ stage: 'reading', completed: 0, total: 1, detail: 'Reading files' })

  // Rasterize everything to page images first so the page count is known
  // before the worksheet row is created.
  const pdfs = files.filter((file) => file.type === 'application/pdf')
  const images = files.filter((file) => file.type !== 'application/pdf')

  const pages: RasterPage[] = []
  let sawPdf = false

  for (const file of pdfs) {
    assertNotAborted(signal)
    sawPdf = true
    const rendered = await rasterizePdf(file, ({ page, total }) => {
      onProgress({
        stage: 'rasterizing',
        completed: page,
        total,
        detail: `Rendering ${file.name}`,
      })
    })
    for (const page of rendered) {
      pages.push({ ...page, pageNumber: pages.length + 1 })
    }
  }

  for (const [index, file] of images.entries()) {
    assertNotAborted(signal)
    onProgress({
      stage: 'rasterizing',
      completed: index + 1,
      total: images.length,
      detail: `Processing ${file.name}`,
    })
    pages.push(await rasterizeImage(file, pages.length + 1))
  }

  if (pages.length === 0) throw new IngestError('Nothing readable in those files.')

  const digital = sawPdf && hasUsableTextLayer(pages)
  const sourceType = sawPdf
    ? digital
      ? 'pdf_digital'
      : 'pdf_scanned'
    : images.some((file) => file.type === 'image/heic' || file.type === 'image/heif')
      ? 'photo'
      : 'image'

  // OCR data is a large download; start fetching it while pages upload.
  if (!digital) preloadOcr()

  assertNotAborted(signal)

  const created = (await expectOk(
    await fetch('/api/worksheets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        sourceType,
        subjectHint: subjectHint || null,
        pageCount: pages.length,
      }),
      signal,
    }),
  )) as { worksheetId: string }

  const worksheetId = created.worksheetId
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
      await fetch(`/api/worksheets/${worksheetId}/pages`, {
        method: 'POST',
        body: form,
        signal,
      }),
    )) as { pageId: string }

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

    const { text, lines } = digital
      ? { text: page.embeddedText, lines: page.embeddedLines }
      : await ocrPage(page.blob)

    await expectOk(
      await fetch(`/api/worksheets/${worksheetId}/pages`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
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
    await fetch(`/api/worksheets/${worksheetId}/complete`, {
      method: 'POST',
      signal,
    }),
  )) as { next: string }

  onProgress({ stage: 'done', completed: 1, total: 1, detail: 'Done' })

  return { worksheetId, pageCount: pages.length, next: finished.next }
}
