import { config } from 'dotenv'

config({ path: '.env.local' })

import sharp from 'sharp'

import { OllamaProvider } from '../lib/ai/ollama'
import type { ExtractedQuestion } from '../lib/ai/types'
import { validated } from '../lib/ai/validated'
import { embed } from '../lib/embeddings'
import { auditExtraction } from '../lib/worker/audit'
import { planReview, type ReviewableQuestion } from '../lib/worker/review'

const API = (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
const TOKEN = process.env.WORKER_API_TOKEN ?? ''
const WORKER_NAME = process.env.WORKER_NAME ?? 'local-gpu'
const VISION_MODEL = process.env.OLLAMA_VISION_MODEL ?? 'qwen2.5vl:7b'
/**
 * Second-opinion model for the review pass. Reads text, never images.
 *
 * Defaults to the vision model so the worker runs with nothing extra pulled.
 * Measured on a real extraction, gpt-oss:20b was the better reviewer: it
 * matched the default on damaged questions and raised no false alarms, where
 * the 7b called two sound questions broken — both of them stems finished by
 * their own options, the same shape that fooled the text checks before they
 * were narrowed. A reviewer that cries wolf costs re-reads, so it is worth
 * setting this.
 */
const REVIEW_MODEL = process.env.OLLAMA_REVIEW_MODEL ?? VISION_MODEL
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
    expectedQuestionCount?: number | null
    checkpoint: { lastPageNumber?: number; donePages?: number[] } | null
  } | null
  pages?: WorkerPage[]
  depth?: { pending: number; running: number }
}

const ollama = new OllamaProvider({
  baseUrl: OLLAMA_URL,
  visionModel: VISION_MODEL,
  textModel: VISION_MODEL,
  reviewModel: REVIEW_MODEL,
  executionSite: 'operator_gpu',
  timeoutMs: 15 * 60_000,
})

// Wrapped, like every other consumer: the provider returns the model's own
// JSON and `validated` is what turns it into something safe to post upstream.
// `ollama` stays in scope only for listModels, which is Ollama's own call and
// not part of the provider contract.
const provider = validated(ollama)

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

async function postJob(jobId: string, body: unknown): Promise<Response> {
  const response = await api(`/api/worker/jobs/${jobId}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    throw new Error(`Job update failed (${response.status}): ${await response.text()}`)
  }

  // Returned so a caller that cares what the server did with the update can
  // read it; most do not, and ignoring it stays valid.
  return response
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

interface PendingQuestion {
  id: string
  promptText: string
}

interface TopicCandidate {
  slug: string
  name: string
  path: string
}

/**
 * Second look at questions that arrived but may not have arrived whole.
 *
 * The audit before this only sees the printed numbering, so a page that
 * produced a question for every number it should have looks perfect to it even
 * when those questions are cut off, missing options, or carrying someone
 * else's answers. Cheap checks find most of that; the review model is asked
 * about the rest.
 */
async function reviewExtractedQuestions(
  job: { id: string; worksheetId: string },
  pages: WorkerPage[],
): Promise<void> {
  const response = await api(`/api/worker/questions/${job.worksheetId}`)
  if (!response.ok) return

  const { questions } = (await response.json()) as { questions: ReviewableQuestion[] }
  if (questions.length === 0) return

  const plan = await planReview(questions, async (candidates) =>
    // Optional on the contract: a provider that cannot review is not a failure,
    // and no opinion is the same answer as an unreadable one.
    (await provider.reviewQuestions?.(candidates)) ?? [],
  )

  if (plan.suspects.length === 0) return

  log(
    `  review: ${plan.suspects.length} of ${questions.length} question(s) look wrong` +
      `${plan.modelConsulted ? '' : ' (cheap checks only, reviewer unavailable)'}` +
      ` — re-reading ${plan.reread.length} page(s)`,
  )

  if (plan.skippedPages.length > 0) {
    log(
      `  review: too much of this worksheet is suspect; ` +
        `left page(s) ${plan.skippedPages.join(', ')} for the student to fix`,
    )
  }

  const byNumber = new Map(pages.map((page) => [page.pageNumber, page]))

  for (const target of plan.reread) {
    if (shuttingDown) return

    const page = byNumber.get(target.pageNumber)
    if (!page) continue

    const replace = plan.suspects
      .filter((suspect) => suspect.pageNumber === target.pageNumber)
      .map((suspect) => suspect.id)

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

      const result = await postJob(job.id, {
        action: 'page_review',
        pageId: page.id,
        replace,
        questions,
      })

      const outcome = (await result.json().catch(() => null)) as {
        replaced?: number
        kept?: number
      } | null

      log(
        `  review: page ${page.pageNumber} re-read — ` +
          `replaced ${outcome?.replaced ?? 0}, kept ${outcome?.kept ?? 0} as-is`,
      )
    } catch (error) {
      // The questions are already saved and the student can edit them. A
      // failed second look is not a failed worksheet.
      log(`  review: page ${page.pageNumber} could not be re-read: ${(error as Error).message}`)
    }
  }
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

  // Worth saying out loud even though nothing is deleted over it: more
  // questions than the paper has means a misread number or a double-count,
  // and the student is about to see one too many on the review screen.
  if (audit.extra.length > 0) {
    log(
      `  audit: ${audit.found} found but only ${audit.expected} expected — ` +
        `numbered past the end: ${audit.extra.join(', ')} (check for duplicates)`,
    )
  }

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

/**
 * Embedding happens here rather than on the server, because this machine has
 * the native runtime the model needs and a serverless host does not. The
 * server keeps the part that is only ever SQL: turning a vector into a
 * shortlist of nearby topics.
 */
async function classifyWorksheet(worksheetId: string): Promise<void> {
  const pendingResponse = await api(`/api/worker/classify/${worksheetId}`)
  if (!pendingResponse.ok) {
    log(`  classify: could not fetch questions (${pendingResponse.status}); skipping`)
    return
  }

  const { questions: pending } = (await pendingResponse.json()) as {
    questions: PendingQuestion[]
  }
  if (pending.length === 0) return

  const items = []
  for (const question of pending) {
    if (shuttingDown) return
    try {
      items.push({ questionId: question.id, embedding: await embed(question.promptText) })
    } catch (error) {
      log(`  classify: could not embed a question — ${(error as Error).message}`)
    }
  }

  if (items.length === 0) return

  const shortlistResponse = await api(`/api/worker/classify/${worksheetId}/shortlist`, {
    method: 'POST',
    body: JSON.stringify({ items }),
  })

  if (!shortlistResponse.ok) {
    log(`  classify: shortlist rejected (${shortlistResponse.status}); skipping`)
    return
  }

  const { batch } = (await shortlistResponse.json()) as {
    batch: { questionId: string; candidates: TopicCandidate[] }[]
  }

  const promptById = new Map(pending.map((question) => [question.id, question.promptText]))
  const results = []

  for (const entry of batch) {
    if (shuttingDown) return

    const promptText = promptById.get(entry.questionId)
    if (!promptText || entry.candidates.length === 0) continue

    try {
      const classification = await provider.classifyTopic(promptText, entry.candidates)

      // The server raises a topic proposal when the match comes back coarse,
      // and dedupes proposals by embedding — another vector it cannot compute
      // itself, so it is sent along.
      const proposedName = classification.suggested_name ?? promptText.slice(0, 80)

      results.push({
        questionId: entry.questionId,
        classification,
        candidates: entry.candidates,
        proposalEmbedding: await embed(proposedName),
      })
    } catch (error) {
      log(`  classify: "${promptText.slice(0, 40)}" failed — ${(error as Error).message}`)
    }
  }

  if (results.length === 0) return

  const post = await api(`/api/worker/classify/${worksheetId}`, {
    method: 'POST',
    body: JSON.stringify({ results }),
  })

  if (post.ok) {
    const summary = (await post.json()) as { applied: number; coarse: number }
    log(`  classified ${summary.applied}/${pending.length} (${summary.coarse} coarse)`)
  } else {
    log(`  classify: server rejected results (${post.status})`)
  }
}

/**
 * Explains one question for an account whose only model is this GPU.
 *
 * The server cannot reach here — the worker dials out and nothing listens —
 * so a trial explanation has to be collected rather than requested, the same
 * way extraction is.
 */
async function processExplainJob(job: { id: string }): Promise<void> {
  const response = await api(`/api/worker/explain/${job.id}`)
  if (!response.ok) {
    throw new Error(`Could not fetch the question to explain (${response.status})`)
  }

  const input = (await response.json()) as {
    questionId: string
    attemptId: string | null
    promptText: string
    choices: { label: string; text: string }[]
    correctAnswer: string | null
    studentAnswer: string | null
  }

  const explanation = await provider.explain({
    promptText: input.promptText,
    choices: input.choices,
    correctAnswer: input.correctAnswer,
    studentAnswer: input.studentAnswer,
  })

  await postJob(job.id, {
    action: 'explanation',
    questionId: input.questionId,
    attemptId: input.attemptId,
    bodyMd: explanation.body_md,
    misconceptionNote: explanation.misconception_note,
    model: VISION_MODEL,
  })

  await postJob(job.id, { action: 'complete' })
  log(`explained ${input.questionId}`)
}

async function processJob(claim: ClaimResponse): Promise<void> {
  const job = claim.job!
  const pages = claim.pages ?? []
  // A set, not a high-water mark. Pages finish out of order once more than
  // one is in flight, so "everything up to N is done" stops being true — and
  // a crash would silently skip whatever was still running below N.
  const done = new Set<number>(job.checkpoint?.donePages ?? [])
  const legacyHighWater = job.checkpoint?.lastPageNumber ?? 0

  // Not every job is a worksheet. Claiming is shared, so the stage decides.
  if (job.stage === 'explain') {
    log(`claimed ${job.id} — explanation (attempt ${job.attemptCount})`)
    try {
      await processExplainJob(job)
    } catch (error) {
      const message = (error as Error).message
      log(`failed ${job.id}: ${message}`)
      await postJob(job.id, { action: 'fail', message }).catch(() => {})
    }
    return
  }

  log(`claimed ${job.id} — ${pages.length} pages (attempt ${job.attemptCount})`)

  let attempted = 0
  let pageFailures = 0
  let lastError = ''

  const todo = pages.filter(
    (page) => !done.has(page.pageNumber) && page.pageNumber > legacyHighWater,
  )

  try {
    for (const page of todo) {
      if (shuttingDown) {
        log('shutting down mid-job; leaving it to be reclaimed')
        return
      }

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

      done.add(page.pageNumber)
    }

    if (attempted > 0 && pageFailures === attempted) {
      throw new Error(`Extraction failed on all ${attempted} pages. Last error: ${lastError}`)
    }

    await postJob(job.id, { action: 'phase', phase: 'verifying' })
    await recoverMissingQuestions(job, pages)

    // After the numbering is repaired, so the review judges the questions the
    // student will actually see rather than ones about to be replaced.
    await reviewExtractedQuestions(job, pages)

    await postJob(job.id, { action: 'phase', phase: 'classifying' })
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

  const models = await ollama.listModels().catch(() => {
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
