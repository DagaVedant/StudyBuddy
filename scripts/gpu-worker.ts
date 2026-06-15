import { config } from 'dotenv'

config({ path: '.env.local' })

import { OllamaProvider } from '../lib/ai/ollama'
import type { ExtractedQuestion } from '../lib/ai/types'

/**
 * The operator GPU pull-worker (spec §3.3).
 *
 * Runs on the machine with the 5080. It only ever dials OUT — there is no
 * inbound port, no tunnel, and no public endpoint on the home network. If this
 * process is not running, jobs queue rather than fail.
 *
 * Run with:  npm run worker
 */

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

async function processJob(claim: ClaimResponse): Promise<void> {
  const job = claim.job!
  const pages = claim.pages ?? []
  const resumeAfter = job.checkpoint?.lastPageNumber ?? 0

  log(`claimed ${job.id} — ${pages.length} pages (attempt ${job.attemptCount})`)

  try {
    for (const page of pages) {
      if (shuttingDown) {
        // Leave the claim to age out; another run resumes from the checkpoint.
        log('shutting down mid-job; leaving it to be reclaimed')
        return
      }

      if (page.pageNumber <= resumeAfter) continue

      const imageResponse = await api(`/api/worker/pages/${page.id}`)
      if (!imageResponse.ok) {
        throw new Error(`Could not fetch page ${page.pageNumber} (${imageResponse.status})`)
      }

      const image = new Uint8Array(await imageResponse.arrayBuffer())
      const started = Date.now()

      let questions: ExtractedQuestion[] = []
      try {
        questions = await provider.extractQuestions({
          image,
          mediaType: imageResponse.headers.get('content-type') ?? 'image/webp',
          text: page.ocrText ?? '',
          width: page.width ?? 0,
          height: page.height ?? 0,
          pageNumber: page.pageNumber,
        })
      } catch (error) {
        // A single unparseable page shouldn't kill a 40-page worksheet.
        log(`  page ${page.pageNumber}: extraction failed — ${(error as Error).message}`)
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
      // The app being down is expected (deploys, laptop asleep) — back off
      // rather than hammering it.
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
