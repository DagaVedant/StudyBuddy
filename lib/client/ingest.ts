import {type FeatureExtractionPipeline} from '@huggingface/transformers'

import {
  describePageRange,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_INPUT_LIMIT,
  EMBEDDING_MODEL,
  MAX_SOURCE_BYTES,
  pageInRange,
  type PageRange,
} from '@/lib/upload'

import {
  hasUsableTextLayer,
  ocrPage,
  preloadOcr,
  rasterizeImage,
  rasterizePdf,
  type RasterPage,
} from './rasterize'
import {fetchJson, throwIfCancelled} from './http'

export type IngestStage =
  | 'reading'
  | 'rasterizing'
  | 'uploading'
  | 'ocr'
  | 'finishing'
  | 'done'

export type IngestProgress = {
  stage: IngestStage
  completed: number
  total: number
  detail: string
}

export type IngestOptions = {
  files: File[]
  title: string
  subjectHint?: string | null
  pageRange?: PageRange | null
  expectedQuestionCount?: number | null
  onProgress: (progress: IngestProgress) => void
  onWorksheetCreated?: (worksheetId: string) => void
  signal?: AbortSignal
}

export type IngestResult = {
  worksheetId: string
  pageCount: number
  next: string
  message?: string
}

function ingestError(message: string) {
  const error = new Error(message)
  error.name = 'IngestError'
  return error
}

async function expectOk(response: Response) {
  if (response.ok) return response.json()

  let problem = 'Request failed (' + response.status + ').'

  try {
    const body = (await response.json()) as {error?: string}
    if (body.error) problem = body.error
  } catch {
    problem = 'Request failed (' + response.status + ').'
  }

  throw ingestError(problem)
}

export async function ingestWorksheet(options: IngestOptions): Promise<IngestResult> {
  const files = options.files
  const title = options.title
  const subjectHint = options.subjectHint
  const onProgress = options.onProgress
  const onWorksheetCreated = options.onWorksheetCreated
  const signal = options.signal

  let pageRange: PageRange | null = null
  if (options.pageRange) pageRange = options.pageRange

  let expectedQuestionCount: number | null = null
  if (options.expectedQuestionCount !== undefined && options.expectedQuestionCount !== null) {
    expectedQuestionCount = options.expectedQuestionCount
  }

  if (files.length === 0) throw ingestError('Pick at least one file.')

  for (let file of files) {
    if (file.size > MAX_SOURCE_BYTES) {
      throw ingestError('"' + file.name + '" is too large to upload.')
    }
  }

  onProgress({stage: 'reading', completed: 0, total: 1, detail: 'Reading files'})

  let pdfs = []
  let images = []

  for (let file of files) {
    if (file.type === 'application/pdf') {
      pdfs.push(file)
    } else {
      images.push(file)
    }
  }

  const pages: RasterPage[] = []
  let sawPdf = false
  let offset = 0

  for (let file of pdfs) {
    throwIfCancelled(signal)
    sawPdf = true

    const rendered = await rasterizePdf(
      file,
      (progress) => {
        onProgress({
          stage: 'rasterizing',
          completed: progress.page,
          total: progress.total,
          detail: 'Rendering ' + file.name,
        })
      },
      {offset, range: pageRange, signal},
    )

    for (let page of rendered.pages) pages.push(page)
    offset = offset + rendered.totalPages
  }

  for (let file of images) {
    throwIfCancelled(signal)
    offset = offset + 1
    if (!pageInRange(offset, pageRange)) continue

    onProgress({
      stage: 'rasterizing',
      completed: pages.length + 1,
      total: pages.length + 1,
      detail: 'Processing ' + file.name,
    })

    pages.push(await rasterizeImage(file, offset, signal))
  }

  if (pages.length === 0) {
    if (!pageRange) throw ingestError('Nothing readable in those files.')

    let word = 'pages'
    if (offset === 1) word = 'page'

    throw ingestError(
      'No pages in ' +
        describePageRange(pageRange) +
        '. That upload has ' +
        offset +
        ' ' +
        word +
        '.',
    )
  }

  let digital = false
  if (sawPdf && hasUsableTextLayer(pages)) digital = true

  let fromCamera = false
  for (let file of images) {
    if (file.type === 'image/heic' || file.type === 'image/heif') fromCamera = true
  }

  let sourceType = 'image'
  if (digital) sourceType = 'pdf_digital'
  else if (sawPdf) sourceType = 'pdf_scanned'
  else if (fromCamera) sourceType = 'photo'

  if (!digital) preloadOcr()

  throwIfCancelled(signal)

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

  if (onWorksheetCreated) onWorksheetCreated(worksheetId)

  const pageIds: string[] = []

  for (let index = 0; index < pages.length; index++) {
    let page = pages[index]

    throwIfCancelled(signal)
    onProgress({
      stage: 'uploading',
      completed: index + 1,
      total: pages.length,
      detail: 'Uploading page ' + page.pageNumber,
    })

    const form = new FormData()
    form.set('image', page.blob, 'page-' + page.pageNumber + '.webp')
    form.set('pageNumber', String(page.pageNumber))
    form.set('width', String(page.width))
    form.set('height', String(page.height))

    const uploaded = (await expectOk(
      await fetchJson('/api/worksheets/' + worksheetId + '/pages', {
        method: 'POST',
        body: form,
        signal,
      }),
    )) as {pageId: string}

    pageIds.push(uploaded.pageId)
  }

  for (let index = 0; index < pages.length; index++) {
    let page = pages[index]

    throwIfCancelled(signal)

    let detail = 'Recognizing text on page ' + page.pageNumber
    if (digital) detail = 'Reading text from page ' + page.pageNumber

    onProgress({stage: 'ocr', completed: index + 1, total: pages.length, detail: detail})

    let text = page.embeddedText
    let lines = page.embeddedLines
    let engine = 'pdf_text'

    if (!digital) {
      const read = await ocrPage(page.blob, signal)
      text = read.text
      lines = read.lines
      engine = 'tesseract'
    }

    await expectOk(
      await fetchJson('/api/worksheets/' + worksheetId + '/pages', {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          pageId: pageIds[index],
          ocrText: text.slice(0, 200000),
          ocrEngine: engine,
          textLines: lines.slice(0, 4000),
        }),
        signal,
      }),
    )
  }

  onProgress({stage: 'finishing', completed: 1, total: 1, detail: 'Wrapping up'})

  const finished = (await expectOk(
    await fetchJson('/api/worksheets/' + worksheetId + '/complete', {method: 'POST', signal}),
  )) as {next: string; message?: string}

  onProgress({stage: 'done', completed: 1, total: 1, detail: 'Done'})

  return {
    worksheetId: worksheetId,
    pageCount: pages.length,
    next: finished.next,
    message: finished.message,
  }
}

export type PageImage = {
  image: Uint8Array
  mediaType: string
}

export async function toPngBytes(blob: Blob): Promise<PageImage> {
  if (blob.type === 'image/png' || blob.type === 'image/jpeg') {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    return {image: bytes, mediaType: blob.type}
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

    const png = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/png')
    })

    if (!png) throw new Error('The page image could not be converted to PNG.')

    const bytes = new Uint8Array(await png.arrayBuffer())
    return {image: bytes, mediaType: 'image/png'}
  } finally {
    bitmap.close()
  }
}

export async function fetchPageImage(imageKey: string) {
  const response = await fetch('/api/files/' + imageKey)
  if (!response.ok) throw new Error('Could not load the page image.')

  return toPngBytes(await response.blob())
}

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null

function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = import('@huggingface/transformers').then((mod) => {
      mod.env.allowLocalModels = false

      return mod.pipeline('feature-extraction', EMBEDDING_MODEL, {
        dtype: 'q8',
      }) as Promise<FeatureExtractionPipeline>
    })
  }

  return extractorPromise
}

export async function embedInBrowser(text: string) {
  const trimmed = text.trim()

  if (!trimmed) {
    let zeros: number[] = []
    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) zeros.push(0)
    return zeros
  }

  const extractor = await getExtractor()

  const output = await extractor(trimmed.slice(0, EMBEDDING_INPUT_LIMIT), {
    pooling: 'mean',
    normalize: true,
  })

  return Array.from(output.data as Float32Array)
}
