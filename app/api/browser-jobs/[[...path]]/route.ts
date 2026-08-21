import {NextResponse} from 'next/server'
import {eq} from 'drizzle-orm'

import {
  bodySchema,
  handleComplete,
  handleExplanation,
  handleFail,
  handlePageResult,
  handlePageReview,
  handlePhase,
  handleSolution,
} from '@/lib/worker/jobs'
import {auth} from '@/auth'
import {claimJob, type JobStage, queueDepth} from '@/lib/queue'
import {db} from '@/lib/db'
import {endpoints} from '@/lib/api'
import {explainInput, unsolvedQuestions} from '@/lib/worker/solutions'
import {ollamaConfig} from '@/lib/ai/ollama'
import {pagesForJob} from '@/lib/worker/pipeline'
import {processingJobs, worksheets} from '@/lib/schema'

async function postJobid(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({error: 'Unauthorized'}, {status: 401})
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

  if (!job || job.userId !== session.user.id) {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  if (job.executor !== 'browser') {
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
const STAGES: JobStage[] = ['extract', 'answer_key', 'explain']

function wantedStages(request: Request): JobStage[] | null {
  const asked = new URL(request.url).searchParams.get('stages')
  if (!asked) return null

  const wanted = asked
    .split(',')
    .map((stage) => stage.trim())
    .filter((stage): stage is JobStage => (STAGES as string[]).includes(stage))

  return wanted.length > 0 ? wanted : null
}

async function postClaim(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({error: 'Unauthorized'}, {status: 401})
  }

  const userId = session.user.id

  const ollama = await ollamaConfig(db, userId)

  if (!ollama) {
    return NextResponse.json({error: 'No Ollama is configured.'}, {status: 409})
  }

  const job = await claimJob(db, 'browser', null, new Date(), userId, wantedStages(request))

  if (!job) {
    return NextResponse.json({job: null, depth: await queueDepth(db, 'browser')})
  }

  const [worksheet] = await db
    .select({
      title: worksheets.title,
      expectedQuestionCount: worksheets.expectedQuestionCount,
    })
    .from(worksheets)
    .where(eq(worksheets.id, job.worksheetId))
    .limit(1)

  const questionId = (job.checkpoint as {questionId?: string} | null)?.questionId

  return NextResponse.json({
    job: {
      id: job.id,
      worksheetId: job.worksheetId,
      stage: job.stage,
      attemptCount: job.attemptCount,
      title: worksheet?.title ?? null,
      expectedQuestionCount: worksheet?.expectedQuestionCount ?? null,
      checkpoint: job.checkpoint,
    },
    ...(job.stage === 'extract'
      ? {pages: await pagesForJob(db, job.worksheetId)}
      : {}),
    ...(job.stage === 'answer_key'
      ? {solve: await unsolvedQuestions(db, job.worksheetId)}
      : {}),
    ...(job.stage === 'explain' && questionId
      ? {explain: await explainInput(db, userId, questionId)}
      : {}),
    ollama,
  })
}

const handle = endpoints([['POST', ':jobId', postJobid], ['POST', 'claim', postClaim]])

export const GET = handle
export const POST = handle
export const PATCH = handle
export const PUT = handle
export const DELETE = handle
