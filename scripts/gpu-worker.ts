import sharp from 'sharp'
import {config} from 'dotenv'

import {
  MAX_REREAD_SHARE,
  planReview,
  type ReviewableQuestion,
} from '../lib/worker/solutions'
import {OllamaProvider} from '../lib/ai/ollama'
import {auditExtraction} from '../lib/worker/audit'
import {embed} from '../lib/taxonomy'
import {isAnswerPage, seamAround} from '../lib/questions/shape'
import {type ExtractedQuestion, validated} from '../lib/ai/types'

config({path: '.env.local'})
const API = (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
const TOKEN = process.env.WORKER_API_TOKEN ?? ''
const WORKER_NAME = process.env.WORKER_NAME ?? 'local-gpu'
const VISION_MODEL = process.env.OLLAMA_VISION_MODEL ?? 'qwen2.5vl:7b'
const REVIEW_MODEL = process.env.OLLAMA_REVIEW_MODEL ?? VISION_MODEL
const ANSWER_MODEL = process.env.OLLAMA_ANSWER_MODEL ?? VISION_MODEL
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

interface ClaimedJob {
  id: string
  worksheetId: string
  stage: string
  attemptCount: number
  expectedQuestionCount?: number | null
  checkpoint: {lastPageNumber?: number; donePages?: number[]} | null
}

interface ClaimResponse {
  job: ClaimedJob | null
  pages?: WorkerPage[]
  depth?: {pending: number; running: number}
}

const ollama = new OllamaProvider({
  baseUrl: OLLAMA_URL,
  visionModel: VISION_MODEL,
  textModel: VISION_MODEL,
  answerModel: ANSWER_MODEL,
  reviewModel: REVIEW_MODEL,
  executionSite: 'operator_gpu',
  timeoutMs: 15 * 60_000,
})

const provider = validated(ollama)

let shuttingDown = false

let jobsInFlight = 0

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

const API_TIMEOUT_MS = 120_000

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(API_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(init.body ? {'Content-Type': 'application/json'} : {}),
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

  return response
}

async function toOllamaImage(
  bytes: Uint8Array,
  mediaType: string,
): Promise<{image: Uint8Array; mediaType: string}> {
  if (mediaType === 'image/png' || mediaType === 'image/jpeg') {
    return {image: bytes, mediaType}
  }
  const png = await sharp(Buffer.from(bytes)).png().toBuffer()
  return {image: new Uint8Array(png), mediaType: 'image/png'}
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

async function reviewExtractedQuestions(
  job: {id: string; worksheetId: string},
  pages: WorkerPage[],
): Promise<void> {
  const response = await api(`/api/worker/questions/${job.worksheetId}`)
  if (!response.ok) return

  const {questions} = (await response.json()) as {questions: ReviewableQuestion[]}
  if (questions.length === 0) return

  const plan = await planReview(questions, async (candidates) =>
    (await provider.reviewQuestions?.(candidates)) ?? [],
  )

  if (plan.suspects.length === 0) return

  log(
    `  review: ${plan.suspects.length} of ${questions.length} question(s) look wrong` +
      `${plan.modelConsulted ? '' : ' (cheap checks only, reviewer unavailable)'}` +
      `, re-reading ${plan.reread.length} page(s)`,
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

    if (isAnswerPage(page.ocrText ?? '')) continue

    const replace = plan.suspects
      .filter((suspect) => suspect.pageNumber === target.pageNumber)
      .map((suspect) => suspect.id)

    try {
      const imageResponse = await api(`/api/worker/pages/${page.id}`)
      if (!imageResponse.ok) continue

      const raw = new Uint8Array(await imageResponse.arrayBuffer())
      const {image, mediaType} = await toOllamaImage(
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
        ...seamAround(pages, pages.indexOf(page)),
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
        `  review: page ${page.pageNumber} re-read: ` +
          `replaced ${outcome?.replaced ?? 0}, kept ${outcome?.kept ?? 0} as-is`,
      )
    } catch (error) {
      log(`  review: page ${page.pageNumber} could not be re-read: ${(error as Error).message}`)
    }
  }
}

async function recoverMissingQuestions(
  job: {id: string; worksheetId: string; expectedQuestionCount?: number | null},
  pages: WorkerPage[],
): Promise<void> {
  const response = await api(`/api/worker/coverage/${job.worksheetId}`)
  if (!response.ok) return

  const coverage = (await response.json()) as {
    pages: {pageNumber: number; printed: number[]; expectsQuestions?: boolean}[]
  }

  const audit = auditExtraction(coverage.pages, job.expectedQuestionCount ?? null)

  if (audit.extra.length > 0) {
    log(
      `  audit: ${audit.found} found but only ${audit.expected} expected: ` +
        `numbered past the end: ${audit.extra.join(', ')} (check for duplicates)`,
    )
  }

  if (audit.silent.length > 0) {
    log(
      `  audit: FAILED page(s) ${audit.silent.join(', ')}: ` +
        `they print questions and returned none`,
    )
  }

  if (audit.retry.length === 0) return

  log(
    `  audit: ${audit.found} found` +
      `${audit.expected ? ` of ${audit.expected}` : ''}, ` +
      `${audit.missing.length > 0 ? `missing ${audit.missing.join(', ')}, ` : ''}` +
      `re-reading ${audit.retry.length} page(s)`,
  )

  const byNumber = new Map(pages.map((page) => [page.pageNumber, page]))

  const rereadCap = Math.max(1, Math.floor(pages.length * MAX_REREAD_SHARE))
  const retrying = audit.retry.slice(0, rereadCap)

  if (retrying.length < audit.retry.length) {
    log(
      `  audit: capped at ${retrying.length} of ${audit.retry.length} page(s); ` +
        `more than ${Math.round(MAX_REREAD_SHARE * 100)}% of this paper looks wrong`,
    )
  }

  for (const target of retrying) {
    if (shuttingDown) return

    const page = byNumber.get(target.pageNumber)
    if (!page) continue

    if (isAnswerPage(page.ocrText ?? '')) continue

    try {
      const imageResponse = await api(`/api/worker/pages/${page.id}`)
      if (!imageResponse.ok) continue

      const raw = new Uint8Array(await imageResponse.arrayBuffer())
      const {image, mediaType} = await toOllamaImage(
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
        ...seamAround(pages, pages.indexOf(page)),
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
      log(`  audit: page ${page.pageNumber} retry failed: ${(error as Error).message}`)
    }
  }
}

async function classifyWorksheet(worksheetId: string): Promise<void> {
  const tried = new Set<string>()
  let applied = 0
  let coarse = 0

  for (;;) {
    if (shuttingDown) return

    const pendingResponse = await api(`/api/worker/classify/${worksheetId}`)
    if (!pendingResponse.ok) {
      log(`  classify: could not fetch questions (${pendingResponse.status}); skipping`)
      return
    }

    const {questions: page} = (await pendingResponse.json()) as {
      questions: PendingQuestion[]
    }

    const pending = page.filter((question) => !tried.has(question.id))
    if (pending.length === 0) break

    for (const question of pending) tried.add(question.id)

    const summary = await classifyBatch(worksheetId, pending)
    if (!summary) return

    applied += summary.applied
    coarse += summary.coarse
  }

  if (tried.size > 0) {
    log(`  classified ${applied}/${tried.size} (${coarse} coarse)`)
  }
}

async function classifyBatch(
  worksheetId: string,
  pending: PendingQuestion[],
): Promise<{applied: number; coarse: number} | null> {
  const items = []
  for (const question of pending) {
    if (shuttingDown) return null
    try {
      items.push({questionId: question.id, embedding: await embed(question.promptText)})
    } catch (error) {
      log(`  classify: could not embed a question: ${(error as Error).message}`)
    }
  }

  if (items.length === 0) return {applied: 0, coarse: 0}

  const shortlistResponse = await api(`/api/worker/classify/${worksheetId}/shortlist`, {
    method: 'POST',
    body: JSON.stringify({items}),
  })

  if (!shortlistResponse.ok) {
    log(`  classify: shortlist rejected (${shortlistResponse.status}); skipping`)
    return null
  }

  const {batch} = (await shortlistResponse.json()) as {
    batch: {questionId: string; candidates: TopicCandidate[]}[]
  }

  const promptById = new Map(pending.map((question) => [question.id, question.promptText]))
  const results = []

  for (const entry of batch) {
    if (shuttingDown) return null

    const promptText = promptById.get(entry.questionId)
    if (!promptText || entry.candidates.length === 0) continue

    try {
      const classification = await provider.classifyTopic(promptText, entry.candidates)

      results.push({
        questionId: entry.questionId,
        classification,
        candidates: entry.candidates,
      })
    } catch (error) {
      log(`  classify: question ${entry.questionId} failed: ${(error as Error).message}`)
    }
  }

  if (results.length === 0) return {applied: 0, coarse: 0}

  const post = await api(`/api/worker/classify/${worksheetId}`, {
    method: 'POST',
    body: JSON.stringify({results}),
  })

  if (!post.ok) {
    log(`  classify: server rejected results (${post.status})`)
    return null
  }

  return (await post.json()) as {applied: number; coarse: number}
}

async function processAnswerJob(job: {id: string; worksheetId: string}): Promise<void> {
  const response = await api(`/api/worker/solutions/${job.worksheetId}`)
  if (!response.ok) {
    throw new Error(`Could not fetch the questions to solve (${response.status})`)
  }

  const {questions: pending} = (await response.json()) as {
    questions: {
      id: string
      promptText: string
      printedNumber: number | null
      pageId: string | null
      choices: {label: string; text: string}[]
    }[]
  }

  if (pending.length === 0) {
    log(`  ${job.worksheetId}: nothing left to solve`)
    return
  }

  log(`  solving ${pending.length} question(s)`)

  let solved = 0
  let declined = 0
  let failed = 0
  let looked = 0

  for (const [index, question] of pending.entries()) {
    if (shuttingDown) {
      log('  shutting down mid-solve; the rest will be reclaimed')
      return
    }

    try {
      let solution = await provider.answerQuestion({
        promptText: question.promptText,
        choices: question.choices,
      })

      if (solution.answer === null && question.pageId) {
        const page = await api(`/api/worker/pages/${question.pageId}`)

        if (page.ok) {
          const image = new Uint8Array(await page.arrayBuffer())
          const {image: converted, mediaType} = await toOllamaImage(
            image,
            page.headers.get('content-type') ?? 'image/webp',
          )

          solution = await provider.answerQuestion({
            promptText: question.promptText,
            choices: question.choices,
            image: converted,
            mediaType,
          })

          if (solution.answer !== null) looked += 1
        }
      }

      await postJob(job.id, {
        action: 'solution',
        questionId: question.id,
        answer: solution.answer,
        workingMd: solution.working,
        traps: solution.traps,
        confidence: solution.confidence,
        model: ANSWER_MODEL,
      })

      if (solution.answer === null) declined += 1
      else solved += 1
    } catch (error) {
      failed += 1
      log(`  question ${question.printedNumber ?? '?'} failed: ${(error as Error).message}`)
    }

    if ((index + 1) % 10 === 0) {
      log(`  ${index + 1}/${pending.length}`)
    }
  }

  log(
    `  solved ${solved}, declined ${declined}, failed ${failed}` +
      (looked > 0 ? `, ${looked} needed the page image` : ''),
  )
}

async function processExplainJob(job: {id: string}): Promise<void> {
  const response = await api(`/api/worker/explain/${job.id}`)
  if (!response.ok) {
    throw new Error(`Could not fetch the question to explain (${response.status})`)
  }

  const input = (await response.json()) as {
    questionId: string
    attemptId: string | null
    promptText: string
    choices: {label: string; text: string}[]
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

  await postJob(job.id, {action: 'complete'})
  log(`explained ${input.questionId}`)
}

async function processJob(claim: ClaimResponse): Promise<void> {
  const job = claim.job!
  const pages = claim.pages ?? []

  if (job.stage === 'answer_key') return processAnswerKeyJob(job)
  if (job.stage === 'explain') return processExplainStageJob(job)
  if (job.stage === 'classify') return processClassifyStageJob(job)
  return processExtractionJob(job, pages)
}

async function processClassifyStageJob(job: ClaimedJob): Promise<void> {
  log(`claimed ${job.id}: sorting into topics (attempt ${job.attemptCount})`)
  try {
    await classifyWorksheet(job.worksheetId)
    await postJob(job.id, {action: 'complete'})
  } catch (error) {
    const message = (error as Error).message
    log(`failed ${job.id}: ${message}`)
    await postJob(job.id, {action: 'fail', message}).catch(() => {})
  }
}

async function processAnswerKeyJob(job: ClaimedJob): Promise<void> {
  log(`claimed ${job.id}: answers (attempt ${job.attemptCount})`)
  try {
    await processAnswerJob(job)
    await postJob(job.id, {action: 'complete'})
  } catch (error) {
    const message = (error as Error).message
    log(`failed ${job.id}: ${message}`)
    await postJob(job.id, {action: 'fail', message}).catch(() => {})
  }
}

async function processExplainStageJob(job: ClaimedJob): Promise<void> {
  log(`claimed ${job.id}: explanation (attempt ${job.attemptCount})`)
  try {
    await processExplainJob(job)
  } catch (error) {
    const message = (error as Error).message
    log(`failed ${job.id}: ${message}`)
    await postJob(job.id, {action: 'fail', message}).catch(() => {})
  }
}

interface PageReadResult {
  attempted: number
  pageFailures: number
  lastError: string
  interrupted: boolean
}

async function readJobPages(
  job: ClaimedJob,
  pages: WorkerPage[],
  todo: WorkerPage[],
  done: Set<number>,
): Promise<PageReadResult> {
  let attempted = 0
  let pageFailures = 0
  let lastError = ''

  for (const page of todo) {
    if (shuttingDown) {
      log('shutting down mid-job; leaving it to be reclaimed')
      return {attempted, pageFailures, lastError, interrupted: true}
    }

    if (isAnswerPage(page.ocrText ?? '')) {
      await postJob(job.id, {
        action: 'page_result',
        pageId: page.id,
        pageNumber: page.pageNumber,
        totalPages: pages.length,
        questions: [],
      })

      log(`  page ${page.pageNumber}/${pages.length}: answer key or solutions, not extracted`)
      done.add(page.pageNumber)
      continue
    }

    const imageResponse = await api(`/api/worker/pages/${page.id}`)
    if (!imageResponse.ok) {
      throw new Error(`Could not fetch page ${page.pageNumber} (${imageResponse.status})`)
    }

    const raw = new Uint8Array(await imageResponse.arrayBuffer())
    const {image, mediaType} = await toOllamaImage(
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
        ...seamAround(pages, pages.indexOf(page)),
      })
    } catch (error) {
      pageFailures += 1
      lastError = (error as Error).message
      log(`  page ${page.pageNumber}: extraction failed, ${lastError}`)
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

  return {attempted, pageFailures, lastError, interrupted: false}
}

async function finishExtraction(job: ClaimedJob, pages: WorkerPage[]): Promise<void> {
  await postJob(job.id, {action: 'phase', phase: 'verifying'})
  await recoverMissingQuestions(job, pages)

  await postJob(job.id, {action: 'phase', phase: 'verifying'})

  await reviewExtractedQuestions(job, pages)

  await postJob(job.id, {action: 'phase', phase: 'classifying'})
  await classifyWorksheet(job.worksheetId)

  await postJob(job.id, {action: 'complete'})
}

async function processExtractionJob(job: ClaimedJob, pages: WorkerPage[]): Promise<void> {
  const done = new Set<number>(job.checkpoint?.donePages ?? [])
  const legacyHighWater = job.checkpoint?.lastPageNumber ?? 0

  log(`claimed ${job.id}: ${pages.length} pages (attempt ${job.attemptCount})`)

  const todo = pages.filter(
    (page) => !done.has(page.pageNumber) && page.pageNumber > legacyHighWater,
  )

  try {
    const read = await readJobPages(job, pages, todo, done)
    if (read.interrupted) return

    if (read.attempted > 0 && read.pageFailures === read.attempted) {
      throw new Error(
        `Extraction failed on all ${read.attempted} pages. Last error: ${read.lastError}`,
      )
    }

    await finishExtraction(job, pages)
    log(`completed ${job.id}`)
  } catch (error) {
    const message = (error as Error).message
    log(`failed ${job.id}: ${message}`)
    await postJob(job.id, {action: 'fail', message}).catch(() => {})
  }
}

async function heartbeatLoop(): Promise<void> {
  while (!shuttingDown) {
    await api('/api/worker/heartbeat', {
      method: 'POST',
      body: JSON.stringify({workerName: WORKER_NAME, modelName: VISION_MODEL, jobsInFlight}),
    }).catch(() => {})

    await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_MS))
  }
}

async function main(): Promise<void> {
  if (!TOKEN) throw new Error('WORKER_API_TOKEN is not set.')

  log(`worker "${WORKER_NAME}" starting`)
  log(`  api:    ${API}`)
  log(`  ollama: ${OLLAMA_URL} (${VISION_MODEL})`)

  const models = await ollama.listModels().catch((error: unknown) => {
    const timedOut = error instanceof Error && error.name === 'TimeoutError'
    throw new Error(
      timedOut
        ? `Ollama at ${OLLAMA_URL} accepted the connection and did not answer. It is up but not responding.`
        : `Cannot reach Ollama at ${OLLAMA_URL}. Is it running?`,
    )
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
        body: JSON.stringify({
          workerName: WORKER_NAME,
          modelName: VISION_MODEL,
          jobsInFlight,
        }),
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

      jobsInFlight += 1
      try {
        await processJob(claim)
      } finally {
        jobsInFlight -= 1
      }
    } catch (error) {
      log(`poll error: ${(error as Error).message}, retrying in ${backoff / 1000}s`)
      await new Promise((resolve) => setTimeout(resolve, backoff))
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
    }
  }

  await api('/api/worker/heartbeat', {
    method: 'POST',
    body: JSON.stringify({workerName: WORKER_NAME, shuttingDown: true}),
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
