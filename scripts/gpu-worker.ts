import { config } from 'dotenv'

config({ path: '.env.local' })

import sharp from 'sharp'

import { OllamaProvider } from '../lib/ai/ollama'
import type { ExtractedQuestion } from '../lib/ai/types'
import { validated } from '../lib/ai/validated'
import { embed } from '../lib/embeddings'
import { isAnswerPage } from '../lib/questions/answer-key'
import { seamAround } from '../lib/questions/page-text'
import { auditExtraction } from '../lib/worker/audit'
import {
  MAX_REREAD_SHARE,
  planReview,
  type ReviewableQuestion,
} from '../lib/worker/review'

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
 * the 7b called two sound questions broken: both of them stems finished by
 * their own options, the same shape that fooled the text checks before they
 * were narrowed. A reviewer that cries wolf costs re-reads, so it is worth
 * setting this.
 */
const REVIEW_MODEL = process.env.OLLAMA_REVIEW_MODEL ?? VISION_MODEL

/**
 * The model that works a question out, which is not the one that reads a page.
 *
 * The vision model was chosen by measuring how well it transcribes; solving is
 * a different skill and gets its own contest, in
 * scripts/benchmark-answers.ts, scored against the papers' own answer keys.
 * Defaults to the vision model so an operator who sets nothing still gets
 * working answers, badly, rather than none.
 */
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

/** Named so `processJob`'s split-out pieces can say what they take. */
interface ClaimedJob {
  id: string
  worksheetId: string
  stage: string
  attemptCount: number
  expectedQuestionCount?: number | null
  checkpoint: { lastPageNumber?: number; donePages?: number[] } | null
}

interface ClaimResponse {
  job: ClaimedJob | null
  pages?: WorkerPage[]
  depth?: { pending: number; running: number }
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

// Wrapped, like every other consumer: the provider returns the model's own
// JSON and `validated` is what turns it into something safe to post upstream.
// `ollama` stays in scope only for listModels, which is Ollama's own call and
// not part of the provider contract.
const provider = validated(ollama)

let shuttingDown = false

// What the dashboard's "jobs in flight" column reports. The loop below takes
// one job at a time, so this is 0 or 1 today, but it is counted rather than
// assumed: the server has no way to know, and hardcoding it there is what made
// the column always read 0.
let jobsInFlight = 0

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

/**
 * How long any single call to the server may take before it is abandoned.
 *
 * Generous, because a page image is megabytes and the claim endpoint does real
 * work, but finite. Without a timeout a call that never answers, which is what
 * a dropped connection on a home broadband line looks like, hangs the loop
 * forever: this worker takes one job at a time, so a stalled fetch also stops
 * the heartbeat. The dashboard then reports the worker offline while it is
 * still holding a claimed job, and the job sits until its claim expires.
 */
const API_TIMEOUT_MS = 120_000

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    // Only when the caller has not brought its own. The shutdown path passes a
    // signal of its own and must keep it.
    signal: init.signal ?? AbortSignal.timeout(API_TIMEOUT_MS),
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

    // Only reachable on a worksheet extracted before key pages were skipped,
    // whose phantom rows are still stored and still look damaged. Re-reading
    // the page cannot help: the server will not store what comes back.
    if (isAnswerPage(page.ocrText ?? '')) continue

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
        // The pages either side, so a question that ran over the fold can be
        // read whole. Indexed against the full list rather than this loop's
        // subset: the page it continued onto is the one next to it in the
        // document, not the next one this pass happens to be reading.
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
      // The questions are already saved and the student can edit them. A
      // failed second look is not a failed worksheet.
      log(`  review: page ${page.pageNumber} could not be re-read: ${(error as Error).message}`)
    }
  }
}

async function recoverMissingQuestions(
  job: { id: string; worksheetId: string; expectedQuestionCount?: number | null },
  pages: WorkerPage[],
): Promise<void> {
  const response = await api(`/api/worker/coverage/${job.worksheetId}`)
  if (!response.ok) return

  const coverage = (await response.json()) as {
    pages: { pageNumber: number; printed: number[]; expectsQuestions?: boolean }[]
  }

  // The count came with the job. It is a column on the worksheet that is
  // written once at upload and never changes, so fetching it again here was
  // a second read of the same row for the same answer.
  const audit = auditExtraction(coverage.pages, job.expectedQuestionCount ?? null)

  // Worth saying out loud even though nothing is deleted over it: more
  // questions than the paper has means a misread number or a double-count,
  // and the student is about to see one too many on the review screen.
  if (audit.extra.length > 0) {
    log(
      `  audit: ${audit.found} found but only ${audit.expected} expected: ` +
        `numbered past the end: ${audit.extra.join(', ')} (check for duplicates)`,
    )
  }

  // Said before the recall line, because it is the more serious finding and it
  // is the one a complete-looking count used to hide. A page that prints
  // questions and returned none is a failure whatever the numbering says.
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

  // The same cap the review path applies, for the same reason: a re-read costs
  // about what the first read cost, so a paper where most pages look wrong must
  // not quietly double the job. This loop had no cap at all, so a badly scanned
  // 75 page worksheet could re-read all 75. Past this point the problem is the
  // extraction as a whole and the student is better served seeing it.
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

    // A key page returns nothing by design, and the server refuses to store
    // anything read off one. Re-reading it would only spend a model call to
    // be told the same thing twice.
    if (isAnswerPage(page.ocrText ?? '')) continue

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
        // The pages either side, so a question that ran over the fold can be
        // read whole. Indexed against the full list rather than this loop's
        // subset: the page it continued onto is the one next to it in the
        // document, not the next one this pass happens to be reading.
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

/**
 * Embedding happens here rather than on the server, because this machine has
 * the native runtime the model needs and a serverless host does not. The
 * server keeps the part that is only ever SQL: turning a vector into a
 * shortlist of nearby topics.
 */
async function classifyWorksheet(worksheetId: string): Promise<void> {
  // The server hands back one page of still-untagged questions at a time, so a
  // paper longer than a page needs more than one ask. What ends the loop is not
  // an empty page: a question the model declines to tag raises a proposal and
  // is left untagged on purpose, so it is still untagged next time and would be
  // handed over again forever. Tracking what has already been tried is the
  // termination condition, and it also means no question is classified twice.
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

    const { questions: page } = (await pendingResponse.json()) as {
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

/**
 * One page of questions, from embedding to posting the results back.
 *
 * Returns null when the server refused a step, which is not something another
 * page will fix, so the caller stops rather than working through the paper
 * failing every time.
 */
async function classifyBatch(
  worksheetId: string,
  pending: PendingQuestion[],
): Promise<{ applied: number; coarse: number } | null> {
  const items = []
  for (const question of pending) {
    if (shuttingDown) return null
    try {
      items.push({ questionId: question.id, embedding: await embed(question.promptText) })
    } catch (error) {
      log(`  classify: could not embed a question: ${(error as Error).message}`)
    }
  }

  // Nothing embedded, but the caller has already marked these as tried, so the
  // next page is different questions rather than these again.
  if (items.length === 0) return { applied: 0, coarse: 0 }

  const shortlistResponse = await api(`/api/worker/classify/${worksheetId}/shortlist`, {
    method: 'POST',
    body: JSON.stringify({ items }),
  })

  if (!shortlistResponse.ok) {
    log(`  classify: shortlist rejected (${shortlistResponse.status}); skipping`)
    return null
  }

  const { batch } = (await shortlistResponse.json()) as {
    batch: { questionId: string; candidates: TopicCandidate[] }[]
  }

  const promptById = new Map(pending.map((question) => [question.id, question.promptText]))
  const results = []

  for (const entry of batch) {
    if (shuttingDown) return null

    const promptText = promptById.get(entry.questionId)
    if (!promptText || entry.candidates.length === 0) continue

    try {
      const classification = await provider.classifyTopic(promptText, entry.candidates)

      // The server raises a topic proposal when the match comes back coarse,
      // and dedupes proposals by embedding, another vector it cannot compute
      // itself, so it is sent along.
      const proposedName = classification.suggested_name ?? promptText.slice(0, 80)

      results.push({
        questionId: entry.questionId,
        classification,
        candidates: entry.candidates,
        proposalEmbedding: await embed(proposedName),
      })
    } catch (error) {
      // The question id, not the question. spec.md:593 keeps student worksheet
      // text out of operator logs, and this line was putting the first 40
      // characters of it on the console of a machine the student has never
      // heard of. The id is enough to find the row when one of these needs
      // chasing, and it is already all over the rest of this file.
      log(`  classify: question ${entry.questionId} failed: ${(error as Error).message}`)
    }
  }

  if (results.length === 0) return { applied: 0, coarse: 0 }

  const post = await api(`/api/worker/classify/${worksheetId}`, {
    method: 'POST',
    body: JSON.stringify({ results }),
  })

  if (!post.ok) {
    log(`  classify: server rejected results (${post.status})`)
    return null
  }

  return (await post.json()) as { applied: number; coarse: number }
}

/**
 * Works out every question on one worksheet, one at a time.
 *
 * Asks the server for what is still unsolved rather than being handed a list,
 * so a restart resumes: whatever has already been posted back is absent from
 * the next answer. On a 114-question paper that is the difference between a
 * retry costing minutes and costing the better part of an hour.
 *
 * Each solution is posted as it is produced rather than batched at the end. The
 * job is long enough that the process will sometimes not survive it, and a
 * batch lost at question 113 is 113 questions of GPU time thrown away.
 *
 * A question that fails is skipped rather than failing the job. Its row is
 * simply absent, so the next run over this worksheet picks it up again.
 */
async function processAnswerJob(job: { id: string; worksheetId: string }): Promise<void> {
  const response = await api(`/api/worker/solutions/${job.worksheetId}`)
  if (!response.ok) {
    throw new Error(`Could not fetch the questions to solve (${response.status})`)
  }

  const { questions: pending } = (await response.json()) as {
    questions: {
      id: string
      promptText: string
      printedNumber: number | null
      pageId: string | null
      choices: { label: string; text: string }[]
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
  /** Answered only after being shown the page. */
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

      /*
       * Asked again with the page, when the text was not enough.
       *
       * A third of a competition paper turns on a graph, a net or a shaded
       * diagram, and the prompt tells the model to decline rather than guess at
       * one it cannot see. It does, correctly: on three AMC 8 papers that was
       * twenty questions refused with the answer sitting in a page image
       * nobody had looked at.
       *
       * Only on a refusal, and only once. The vision model is slower than the
       * one that just declined and most questions never reach here, so making
       * this the first attempt would pay that cost on every question to help
       * the few that need it. A second refusal is taken at face value.
       */
      if (solution.answer === null && question.pageId) {
        const page = await api(`/api/worker/pages/${question.pageId}`)

        if (page.ok) {
          const image = new Uint8Array(await page.arrayBuffer())
          const { image: converted, mediaType } = await toOllamaImage(
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

    // Deliberately no progress post. The `phase` action is not a progress
    // report: it runs the repair passes, which is right once at the end of an
    // extraction and catastrophic once per question here. Answer progress
    // needs its own action before it can be reported, and nothing shows it yet.
    if ((index + 1) % 10 === 0) {
      log(`  ${index + 1}/${pending.length}`)
    }
  }

  log(
    `  solved ${solved}, declined ${declined}, failed ${failed}` +
      (looked > 0 ? `, ${looked} needed the page image` : ''),
  )
}

/**
 * Explains one question for an account whose only model is this GPU.
 *
 * The server cannot reach here (the worker dials out and nothing listens)
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

/**
 * Claiming is shared across three unrelated pipelines, and the stage decides
 * which one a job actually means. Split into one function per stage rather
 * than kept as one function with three branches, because that is what let the
 * extraction branch alone grow past 120 lines without anyone noticing the
 * other two were still short: the length was never evenly spread, so neither
 * was the difficulty of reviewing it.
 */
async function processJob(claim: ClaimResponse): Promise<void> {
  const job = claim.job!
  const pages = claim.pages ?? []

  if (job.stage === 'answer_key') return processAnswerKeyJob(job)
  if (job.stage === 'explain') return processExplainStageJob(job)
  return processExtractionJob(job, pages)
}

async function processAnswerKeyJob(job: ClaimedJob): Promise<void> {
  log(`claimed ${job.id}: answers (attempt ${job.attemptCount})`)
  try {
    await processAnswerJob(job)
    await postJob(job.id, { action: 'complete' })
  } catch (error) {
    const message = (error as Error).message
    log(`failed ${job.id}: ${message}`)
    await postJob(job.id, { action: 'fail', message }).catch(() => {})
  }
}

async function processExplainStageJob(job: ClaimedJob): Promise<void> {
  log(`claimed ${job.id}: explanation (attempt ${job.attemptCount})`)
  try {
    await processExplainJob(job)
  } catch (error) {
    const message = (error as Error).message
    log(`failed ${job.id}: ${message}`)
    await postJob(job.id, { action: 'fail', message }).catch(() => {})
  }
}

/** What one pass over a job's pages found, for the caller to judge. */
interface PageReadResult {
  attempted: number
  pageFailures: number
  lastError: string
  /** True when a shutdown cut the pass short before every page was tried. */
  interrupted: boolean
}

/**
 * Reads every page still owed on this job, posting each result as it goes.
 *
 * Counts rather than throws on a single page's failure, because one bad page
 * in seventy-five is not the job failing; `processExtractionJob` is the one
 * that decides what the counts mean.
 */
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
      return { attempted, pageFailures, lastError, interrupted: true }
    }

    // The paper's answer key and worked solutions are not questions, and the
    // model reads them as questions regardless of what the system prompt
    // says. The server drops anything read off one; skipping here saves the
    // call. Sixteen phantom rows in the last run came off these pages, and
    // they carried real question numbers, which is what blinded the audit.
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
        // The pages either side, so a question that ran over the fold can be
        // read whole. Indexed against the full list rather than this loop's
        // subset: the page it continued onto is the one next to it in the
        // document, not the next one this pass happens to be reading.
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

  return { attempted, pageFailures, lastError, interrupted: false }
}

/**
 * Everything that runs once every page has been read: the repair passes,
 * classification, and marking the job complete.
 */
async function finishExtraction(job: ClaimedJob, pages: WorkerPage[]): Promise<void> {
  await postJob(job.id, { action: 'phase', phase: 'verifying' })
  await recoverMissingQuestions(job, pages)

  // Again, because the audit just added rows that have never been through
  // the repair passes. A question recovered by the re-read arrives in the
  // shape a page break leaves: the stem and option A on one page, B, C and D
  // at the top of the next. The review below would see the short option list,
  // call it damaged and spend a second vision call re-reading the page, when
  // the missing options are already sitting in the stored text and the
  // carried-options pass takes them for nothing. It ran before the audit and
  // would not run again until classifying, one step too late to save the
  // call. Repeating it is safe; a second run with nothing to do finds
  // nothing.
  await postJob(job.id, { action: 'phase', phase: 'verifying' })

  // After the numbering is repaired, so the review judges the questions the
  // student will actually see rather than ones about to be replaced.
  await reviewExtractedQuestions(job, pages)

  await postJob(job.id, { action: 'phase', phase: 'classifying' })
  await classifyWorksheet(job.worksheetId)

  await postJob(job.id, { action: 'complete' })
}

async function processExtractionJob(job: ClaimedJob, pages: WorkerPage[]): Promise<void> {
  // A set, not a high-water mark. Pages finish out of order once more than
  // one is in flight, so "everything up to N is done" stops being true, and
  // a crash would silently skip whatever was still running below N.
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
    await postJob(job.id, { action: 'fail', message }).catch(() => {})
  }
}

async function heartbeatLoop(): Promise<void> {
  while (!shuttingDown) {
    await api('/api/worker/heartbeat', {
      method: 'POST',
      body: JSON.stringify({
        workerName: WORKER_NAME,
        modelName: VISION_MODEL,
        jobsInFlight,
      }),
    }).catch(() => {})

    await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_MS))
  }
}

async function main(): Promise<void> {
  if (!TOKEN) throw new Error('WORKER_API_TOKEN is not set.')

  log(`worker "${WORKER_NAME}" starting`)
  log(`  api:    ${API}`)
  log(`  ollama: ${OLLAMA_URL} (${VISION_MODEL})`)

  // "Is it running?" is the wrong question when the answer is that it is
  // running and wedged, which is what a timeout here means and what used to
  // hang this line forever instead of reporting anything.
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
