import { config } from 'dotenv'

config({ path: '.env.local' })

import sharp from 'sharp'

import { OllamaProvider } from '../lib/ai/ollama'
import type { ExtractedQuestion } from '../lib/ai/types'
import { auditExtraction } from '../lib/worker/audit'

const API = (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
const TOKEN = process.env.WORKER_API_TOKEN ?? ''
const WORKER_NAME = process.env.WORKER_NAME ?? 'local-gpu'
const VISION_MODEL = process.env.OLLAMA_VISION_MODEL ?? 'qwen2.5vl:7b'
const OLLAMA_URL = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434'

const IDLE_POLL_MS = 5_000
const HEARTBEAT_MS = 30_000
const BACKOFF_MAX_MS = 60_000

interface WorkerPage {
  id: string
  pageNumber: number
  imageKey: string
  ocrText: string | null
  width: number | null
  height: number | null
}

interface ClaimResponse {
  job: {
    id: string
    worksheetId: string
    stage: string
    attemptCount: number
    checkpoint: { lastPageNumber?: number } | null
  } | null
  pages?: WorkerPage[]
  depth?: { pending: number; running: number }
}

const provider = new OllamaProvider({
  baseUrl: OLLAMA_URL,
  visionModel: VISION_MODEL,
  textModel: VISION_MODEL,
  executionSite: 'operator_gpu',
  timeoutMs: 15 * 60_000,
})

let shuttingDown = false

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
}

async function postJob(jobId: string, body: unknown): Promise<void> {
  const response = await api(`/api/worker/jobs/${jobId}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    throw new Error(`Job update failed (${response.status}): ${await response.text()}`)
  }
}

async function toOllamaImage(
  bytes: Uint8Array,
  mediaType: string,
): Promise<{ image: Uint8Array; mediaType: string }> {
  if (mediaType === 'image/png' || mediaType === 'image/jpeg') {
    return { image: bytes, mediaType }
  }
  const png = await sharp(Buffer.from(bytes)).png().toBuffer()
  return { image: new Uint8Array(png), mediaType: 'image/png' }
}

interface ClassifyBatchEntry {
  questionId: string
  promptText: string
  candidates: { slug: string; name: string; path: string }[]
}

async function recoverMissingQuestions(
  job: { id: string; worksheetId: string },
  pages: WorkerPage[],
): Promise<void> {
  const response = await api(`/api/worker/coverage/${job.worksheetId}`)
  if (!response.ok) return

  const coverage = (await response.json()) as {
    pages: { pageNumber: number; printed: number[] }[]
    expectedTotal: number | null
  }

  const audit = auditExtraction(coverage.pages, coverage.expectedTotal)
  if (audit.retry.length === 0) return

  log(
    `  audit: ${audit.found} found` +
      `${audit.expected ? ` of ${audit.expected}` : ''}, ` +
      `missing ${audit.missing.join(', ')} — re-reading ${audit.retry.length} page(s)`,
  )

  const byNumber = new Map(pages.map((page) => [page.pageNumber, page]))

  for (const target of audit.retry) {
    if (shuttingDown) return

    const page = byNumber.get(target.pageNumber)
    if (!page) continue

    try {
      const imageResponse = await api(`/api/worker/pages/${page.id}`)
      if (!imageResponse.ok) continue

      const raw = new Uint8Array(await imageResponse.arrayBuffer())
      const { image, mediaType } = await toOllamaImage(
        raw,
        imageResponse.headers.get('content-type') ?? 'image/webp',
      )

      const questions = await provider.extractQuestions({
        image,
        mediaType,
        text: page.ocrText ?? '',
        width: page.width ?? 0,
        height: page.height ?? 0,
        pageNumber: page.pageNumber,
        expect: target.expect,
      })

      await postJob(job.id, {
        action: 'page_result',
        pageId: page.id,
        pageNumber: page.pageNumber,
        totalPages: pages.length,
        questions,
      })

      log(`  audit: page ${page.pageNumber} re-read for ${target.expect.join(', ')}`)
    } catch (error) {

      log(`  audit: page ${page.pageNumber} retry failed — ${(error as Error).message}`)
    }
  }
}

async function classifyWorksheet(worksheetId: string): Promise<void> {
  const batchResponse = await api(`/api/worker/classify/${worksheetId}`)
  if (!batchResponse.ok) {
    log(`  classify: could not fetch batch (${batchResponse.status}); skipping`)
    return
  }

  const { batch } = (await batchResponse.json()) as { batch: ClassifyBatchEntry[] }
  if (batch.length === 0) return

  const results = []
  for (const entry of batch) {
    if (shuttingDown) return
    try {
      const classification = await provider.classifyTopic(
        entry.promptText,
        entry.candidates,
      )
      results.push({ questionId: entry.questionId, classification })
    } catch (error) {
      log(`  classify: "${entry.promptText.slice(0, 40)}" failed — ${(error as Error).message}`)
    }
  }

  if (results.length === 0) return

  const post = await api(`/api/worker/classify/${worksheetId}`, {
    method: 'POST',
    body: JSON.stringify({ results }),
  })

  if (post.ok) {
    const summary = (await post.json()) as { applied: number; coarse: number }
    log(`  classified ${summary.applied}/${batch.length} (${summary.coarse} coarse)`)
  } else {
    log(`  classify: server rejected results (${post.status})`)
  }
}

async function processJob(claim: ClaimResponse): Promise<void> {
  const job = claim.job!
  const pages = claim.pages ?? []
  const resumeAfter = job.checkpoint?.lastPageNumber ?? 0

  log(`claimed ${job.id} — ${pages.length} pages (attempt ${job.attemptCount})`)

  let attempted = 0
  let pageFailures = 0
  let lastError = ''

  try {
    for (const page of pages) {
      if (shuttingDown) {

        log('shutting down mid-job; leaving it to be reclaimed')
        return
      }

      if (page.pageNumber <= resumeAfter) continue

      const imageResponse = await api(`/api/worker/pages/${page.id}`)
      if (!imageResponse.ok) {
        throw new Error(`Could not fetch page ${page.pageNumber} (${imageResponse.status})`)
      }

      const raw = new Uint8Array(await imageResponse.arrayBuffer())
      const { image, mediaType } = await toOllamaImage(
        raw,
        imageResponse.headers.get('content-type') ?? 'image/webp',
      )

      const started = Date.now()
      attempted += 1

      let questions: ExtractedQuestion[] = []
      try {
        questions = await provider.extractQuestions({
          image,
          mediaType,
          text: page.ocrText ?? '',
          width: page.width ?? 0,
          height: page.height ?? 0,
          pageNumber: page.pageNumber,
        })
      } catch (error) {

        pageFailures += 1
        lastError = (error as Error).message
        log(`  page ${page.pageNumber}: extraction failed — ${lastError}`)
      }

      await postJob(job.id, {
        action: 'page_result',
        pageId: page.id,
        pageNumber: page.pageNumber,
        totalPages: pages.length,
        questions,
      })

      log(
        `  page ${page.pageNumber}/${pages.length}: ${questions.length} questions ` +
          `(${((Date.now() - started) / 1000).toFixed(1)}s)`,
      )
    }

    if (attempted > 0 && pageFailures === attempted) {
      throw new Error(`Extraction failed on all ${attempted} pages. Last error: ${lastError}`)
    }

    await recoverMissingQuestions(job, pages)
    await classifyWorksheet(job.worksheetId)

    await postJob(job.id, { action: 'complete' })
    log(`completed ${job.id}`)
  } catch (error) {
    const message = (error as Error).message
    log(`failed ${job.id}: ${message}`)
    await postJob(job.id, { action: 'fail', message }).catch(() => {})
  }
}

async function heartbeatLoop(): Promise<void> {
  while (!shuttingDown) {
    await api('/api/worker/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ workerName: WORKER_NAME, modelName: VISION_MODEL }),
    }).catch(() => {})

    await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_MS))
  }
}

async function main(): Promise<void> {
  if (!TOKEN) throw new Error('WORKER_API_TOKEN is not set.')

  log(`worker "${WORKER_NAME}" starting`)
  log(`  api:    ${API}`)
  log(`  ollama: ${OLLAMA_URL} (${VISION_MODEL})`)

  const models = await provider.listModels().catch(() => {
    throw new Error(`Cannot reach Ollama at ${OLLAMA_URL}. Is it running?`)
  })

  if (!models.includes(VISION_MODEL)) {
    throw new Error(`${VISION_MODEL} is not pulled. Run: ollama pull ${VISION_MODEL}`)
  }

  void heartbeatLoop()

  let backoff = IDLE_POLL_MS

  while (!shuttingDown) {
    try {
      const response = await api('/api/worker/claim', {
        method: 'POST',
        body: JSON.stringify({ workerName: WORKER_NAME, modelName: VISION_MODEL }),
      })

      if (!response.ok) {
        throw new Error(`claim failed (${response.status})`)
      }

      const claim = (await response.json()) as ClaimResponse
      backoff = IDLE_POLL_MS

      if (!claim.job) {
        await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS))
        continue
      }

      await processJob(claim)
    } catch (error) {

      log(`poll error: ${(error as Error).message} — retrying in ${backoff / 1000}s`)
      await new Promise((resolve) => setTimeout(resolve, backoff))
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
    }
  }

  await api('/api/worker/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ workerName: WORKER_NAME, shuttingDown: true }),
  }).catch(() => {})

  log('worker stopped')
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(1)
    shuttingDown = true
    log('shutdown requested; finishing current page')
  })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
