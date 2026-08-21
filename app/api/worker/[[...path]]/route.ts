import {NextResponse} from 'next/server'
import {and, asc, eq, inArray} from 'drizzle-orm'
import {z} from 'zod'

import {
  applyClassification,
  isEmbedding,
  pendingQuestions,
  shortlistByVector,
} from '@/lib/taxonomy'
import {
  authenticateWorker,
  bodySchema,
  handleComplete,
  handleExplanation,
  handleFail,
  handlePageResult,
  handlePageReview,
  handlePhase,
  handleSolution,
} from '@/lib/worker/jobs'
import {
  claimJob,
  heartbeat,
  markWorkerOffline,
  queueDepth,
  reapAbandonedJobs,
} from '@/lib/queue'
import {
  processingJobs,
  questions,
  worksheetPages,
  worksheets,
} from '@/lib/db/schema'
import {applyPermanentFailure, clearUntagged} from '@/lib/worker/apply'
import {classificationSchema} from '@/lib/ai/types'
import {countQuestionStarts, isAnswerPage} from '@/lib/questions/text'
import {db} from '@/lib/db'
import {endpoints} from '@/lib/api'
import {explainInput, unsolvedQuestions} from '@/lib/worker/solutions'
import {loadQuestionsWithChoices} from '@/lib/questions/queries'
import {pagesForJob} from '@/lib/worker/ingest'
import {storage} from '@/lib/storage'

const claimSchema = z.object({
  workerName: z.string().trim().min(1).max(100),
  modelName: z.string().trim().max(200).nullish(),
  jobsInFlight: z.number().int().min(0).max(64).default(0),
})

async function postClaim(request: Request) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({error: auth.message}, {status: auth.status})
  }

  const parsed = claimSchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const {workerName, modelName, jobsInFlight} = parsed.data

  const workerId = await heartbeat(db, workerName, modelName ?? null, jobsInFlight)

  for (const abandoned of await reapAbandonedJobs(db)) {
    console.log(
      `[queue] reaped abandoned ${abandoned.stage} job ${abandoned.id} on ` +
        `worksheet ${abandoned.worksheetId}`,
    )
    await applyPermanentFailure(db, abandoned)
  }

  const job = await claimJob(db, 'operator_gpu', workerId)

  if (!job) {
    const depth = await queueDepth(db, 'operator_gpu')
    return NextResponse.json({job: null, depth})
  }

  await heartbeat(db, workerName, modelName ?? null, jobsInFlight + 1)

  const [worksheet] = await db
    .select({expectedQuestionCount: worksheets.expectedQuestionCount})
    .from(worksheets)
    .where(eq(worksheets.id, job.worksheetId))
    .limit(1)

  return NextResponse.json({
    job: {
      id: job.id,
      worksheetId: job.worksheetId,
      stage: job.stage,
      attemptCount: job.attemptCount,
      expectedQuestionCount: worksheet?.expectedQuestionCount ?? null,
      checkpoint: job.checkpoint,
    },
    pages: await pagesForJob(db, job.worksheetId),
  })
}

async function getClassifyWorksheetid(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({error: auth.message}, {status: auth.status})
  }

  const {worksheetId} = await params

  const [worksheet] = await db
    .select({subjectHint: worksheets.subjectHint})
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  if (!worksheet) {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  return NextResponse.json({
    subjectHint: worksheet.subjectHint,
    questions: await pendingQuestions(db, worksheetId),
  })
}

const candidateSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
})

const resultsSchema = z.object({
  results: z
    .array(
      z.object({
        questionId: z.string().min(1),
        classification: classificationSchema,
        candidates: z.array(candidateSchema).max(64),
      }),
    )
    .max(100),
})

async function postClassifyWorksheetid(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({error: auth.message}, {status: auth.status})
  }

  const {worksheetId} = await params
  const parsed = resultsSchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const [worksheet] = await db
    .select({id: worksheets.id})
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  if (!worksheet) {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  let applied = 0
  let coarse = 0

  for (const entry of parsed.data.results) {
    const [question] = await db
      .select({
        id: questions.id,
        promptText: questions.promptText,
        userId: questions.userId,
        worksheetId: questions.worksheetId,
      })
      .from(questions)
      .where(eq(questions.id, entry.questionId))
      .limit(1)

    if (!question || question.worksheetId !== worksheetId) continue

    try {
      const outcome = await applyClassification(
        db,
        question,
        entry.candidates,
        entry.classification,
      )
      if (outcome.topicId) applied += 1
      if (outcome.coarse) coarse += 1
    } catch {}
  }

  const remaining = await pendingQuestions(db, worksheetId, 1)

  if (remaining.length === 0) {
    await clearUntagged(db, worksheetId)
  }

  return NextResponse.json({
    ok: true,
    applied,
    coarse,
    done: remaining.length === 0,
  })
}

const schema = z.object({
  items: z
    .array(
      z.object({
        questionId: z.string().min(1),
        embedding: z.array(z.number()),
      }),
    )
    .max(100),
})

async function postClassifyWorksheetidShortlist(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({error: auth.message}, {status: auth.status})
  }

  const {worksheetId} = await params
  const parsed = schema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const [worksheet] = await db
    .select({subjectHint: worksheets.subjectHint})
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  if (!worksheet) {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  const batch = []

  for (const item of parsed.data.items) {
    if (!isEmbedding(item.embedding)) continue

    await db
      .update(questions)
      .set({embedding: item.embedding})
      .where(
        and(eq(questions.id, item.questionId), eq(questions.worksheetId, worksheetId)),
      )

    batch.push({
      questionId: item.questionId,
      candidates: await shortlistByVector(db, item.embedding, {
        subjectHint: worksheet.subjectHint,
      }),
    })
  }

  return NextResponse.json({batch})
}

async function getCoverageWorksheetid(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({error: auth.message}, {status: auth.status})
  }

  const {worksheetId} = await params

  const [worksheet] = await db
    .select({id: worksheets.id})
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  if (!worksheet) {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  const pages = await db
    .select({
      id: worksheetPages.id,
      pageNumber: worksheetPages.pageNumber,
      ocrText: worksheetPages.ocrText,
    })
    .from(worksheetPages)
    .where(eq(worksheetPages.worksheetId, worksheetId))
    .orderBy(asc(worksheetPages.pageNumber))

  const rows = await db
    .select({pageId: questions.pageId, printedNumber: questions.printedNumber})
    .from(questions)
    .where(eq(questions.worksheetId, worksheetId))

  const byPage = new Map<string, number[]>()
  for (const row of rows) {
    if (!row.pageId || row.printedNumber === null) continue
    const list = byPage.get(row.pageId) ?? []
    list.push(row.printedNumber)
    byPage.set(row.pageId, list)
  }

  return NextResponse.json({
    pages: pages.map((page) => {
      const text = page.ocrText ?? ''

      return {
        pageNumber: page.pageNumber,
        printed: byPage.get(page.id) ?? [],
        expectsQuestions: countQuestionStarts(text) > 0 && !isAnswerPage(text),
      }
    }),
  })
}

async function getExplainJobid(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({error: auth.message}, {status: auth.status})
  }

  const {jobId} = await params

  const [job] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId))
    .limit(1)

  if (!job || job.stage !== 'explain') {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  const questionId = (job.checkpoint as {questionId?: string} | null)?.questionId
  if (!questionId) {
    return NextResponse.json({error: 'Job names no question'}, {status: 400})
  }

  const input = await explainInput(db, job.userId, questionId)
  if (!input) {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  return NextResponse.json(input)
}
const schema2 = z.object({
  workerName: z.string().trim().min(1).max(100),
  modelName: z.string().trim().max(200).nullish(),
  jobsInFlight: z.number().int().min(0).max(64).default(0),
  shuttingDown: z.boolean().default(false),
})

async function postHeartbeat(request: Request) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({error: auth.message}, {status: auth.status})
  }

  const parsed = schema2.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const {workerName, modelName, jobsInFlight, shuttingDown} = parsed.data

  if (shuttingDown) {
    await markWorkerOffline(db, workerName)
    return NextResponse.json({ok: true})
  }

  await heartbeat(db, workerName, modelName ?? null, jobsInFlight)

  return NextResponse.json({
    ok: true,
    depth: await queueDepth(db, 'operator_gpu'),
  })
}

async function postJobsJobid(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({error: auth.message}, {status: auth.status})
  }

  const {jobId} = await params
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const [job] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId))
    .limit(1)

  if (!job) {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  const body = parsed.data

  if (body.action !== 'fail' && job.status !== 'claimed' && job.status !== 'running') {
    return NextResponse.json(
      {error: `Job is ${job.status}, not accepting work`, status: job.status},
      {status: 409},
    )
  }

  switch (body.action) {
    case 'fail':
      return handleFail(db, jobId, job, body)
    case 'phase':
      return handlePhase(db, jobId, job, body)
    case 'page_review':
      return handlePageReview(db, job, body)
    case 'explanation':
      return handleExplanation(db, job, body)
    case 'solution':
      return handleSolution(db, jobId, job, body)
    case 'complete':
      return handleComplete(db, jobId, job)
    case 'page_result':
      return handlePageResult(db, jobId, job, body)
  }
}

async function getPagesPageid(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({error: auth.message}, {status: auth.status})
  }

  const {pageId} = await params

  const [page] = await db
    .select({
      imageKey: worksheetPages.imageKey,
      worksheetId: worksheetPages.worksheetId,
    })
    .from(worksheetPages)
    .where(eq(worksheetPages.id, pageId))
    .limit(1)

  if (!page) {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  const active = await db
    .select({id: processingJobs.id})
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.worksheetId, page.worksheetId),
        eq(processingJobs.executor, 'operator_gpu'),
        inArray(processingJobs.status, ['claimed', 'running']),
      ),
    )
    .limit(1)

  if (active.length === 0) {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  const object = await storage.getStream(page.imageKey)
  if (!object) {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  const headers = new Headers({
    'Content-Type': object.contentType,
    'Cache-Control': 'no-store',
  })

  if (object.size !== null) headers.set('Content-Length', String(object.size))

  return new NextResponse(object.stream, {headers})
}

async function getQuestionsWorksheetid(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({error: auth.message}, {status: auth.status})
  }

  const {worksheetId} = await params

  const pages = await db
    .select({id: worksheetPages.id, pageNumber: worksheetPages.pageNumber})
    .from(worksheetPages)
    .where(eq(worksheetPages.worksheetId, worksheetId))
    .orderBy(asc(worksheetPages.pageNumber))

  const rows = await loadQuestionsWithChoices(db, worksheetId)

  if (rows.length === 0) return NextResponse.json({questions: []})

  const pageNumberFor = new Map(pages.map((page) => [page.id, page.pageNumber]))

  return NextResponse.json({
    questions: rows
      .filter((row) => row.pageId && pageNumberFor.has(row.pageId))
      .map((row) => ({
        id: row.id,
        pageNumber: pageNumberFor.get(row.pageId as string) as number,
        printedNumber: row.printedNumber,
        promptText: row.promptText,
        questionType: row.questionType,
        choices: row.choices.map((choice) => ({label: choice.label, text: choice.text})),
      })),
  })
}

async function getSolutionsWorksheetid(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({error: auth.message}, {status: auth.status})
  }

  const {worksheetId} = await params

  return NextResponse.json({questions: await unsolvedQuestions(db, worksheetId)})
}

const handle = endpoints([
  ['POST', 'claim', postClaim],
  ['GET', 'classify/:worksheetId', getClassifyWorksheetid],
  ['POST', 'classify/:worksheetId', postClassifyWorksheetid],
  ['POST', 'classify/:worksheetId/shortlist', postClassifyWorksheetidShortlist],
  ['GET', 'coverage/:worksheetId', getCoverageWorksheetid],
  ['GET', 'explain/:jobId', getExplainJobid],
  ['POST', 'heartbeat', postHeartbeat],
  ['POST', 'jobs/:jobId', postJobsJobid],
  ['GET', 'pages/:pageId', getPagesPageid],
  ['GET', 'questions/:worksheetId', getQuestionsWorksheetid],
  ['GET', 'solutions/:worksheetId', getSolutionsWorksheetid],
])

export const GET = handle
export const POST = handle
export const PATCH = handle
export const PUT = handle
export const DELETE = handle
