import {timingSafeEqual} from 'node:crypto'

import {NextResponse} from 'next/server'
import {and, eq, inArray} from 'drizzle-orm'
import {z} from 'zod'

import {
  FINAL_PASSES,
  persistQuestions,
  runExtraction,
  runRepairPasses,
  VERIFYING_PASSES,
} from '@/lib/worker/pipeline'
import {answerChoices, explanations, processingJobs, questions, questionSolutions, worksheetPages, worksheets} from '@/lib/schema'
import {
  applyPermanentFailure,
  CLASSIFYING_AT,
  partitionByDeletability,
  readingProgress,
  recordUntagged,
  UNTAGGED_REASON,
  VERIFYING_AT,
} from '@/lib/worker/apply'
import {
  checkpointJob,
  type ClaimedJob,
  claimJob,
  completeJob,
  enqueueJob,
  failJob,
  touchJob,
  transitionWorksheet,
} from '@/lib/queue'
import {
  deriveSolutions,
  planPageReplacement,
  promoteDerivedAnswer,
} from '@/lib/worker/solutions'
import {CHOICE_ORDER} from '@/lib/questions/queries'
import {classifyWorksheet, EmbeddingUnavailableError} from '@/lib/taxonomy'
import {clientIp} from '@/lib/api'
import {type AIProvider, extractedQuestionSchema} from '@/lib/ai/types'
import {type Db} from '@/lib/db'
import {resolveProvider} from '@/lib/ai/resolve'

const pageResultSchema = z.object({
  action: z.literal('page_result'),
  pageId: z.string().min(1),
  pageNumber: z.number().int().min(1),
  totalPages: z.number().int().min(1),
  questions: z.array(extractedQuestionSchema).max(100),
})

const phaseSchema = z.object({
  action: z.literal('phase'),
  phase: z.enum(['verifying', 'classifying']),
})

const pageReviewSchema = z.object({
  action: z.literal('page_review'),
  pageId: z.string().min(1),
  replace: z.array(z.string().uuid()).max(100),
  questions: z.array(extractedQuestionSchema).max(100),
})

const explanationSchema = z.object({
  action: z.literal('explanation'),
  questionId: z.string().uuid(),
  attemptId: z.string().uuid().nullish(),
  bodyMd: z.string().min(1).max(6000),
  misconceptionNote: z.string().max(400).nullish(),
  model: z.string().max(200),
})

const solutionSchema = z.object({
  action: z.literal('solution'),
  questionId: z.string().uuid(),
  answer: z.string().max(400).nullable(),
  workingMd: z.string().max(8000),
  traps: z
    .array(z.object({label: z.string().max(8).nullable(), why: z.string().max(600)}))
    .max(12)
    .default([]),
  confidence: z.number().min(0).max(1),
  model: z.string().max(200),
})

const completeSchema = z.object({action: z.literal('complete')})

const failSchema = z.object({action: z.literal('fail'), message: z.string().max(2000)})

export const bodySchema = z.discriminatedUnion('action', [
  pageResultSchema,
  phaseSchema,
  pageReviewSchema,
  explanationSchema,
  solutionSchema,
  completeSchema,
  failSchema,
])

export type Job = typeof processingJobs.$inferSelect

type PageResultBody = z.infer<typeof pageResultSchema>
type PhaseBody = z.infer<typeof phaseSchema>
type PageReviewBody = z.infer<typeof pageReviewSchema>
type ExplanationBody = z.infer<typeof explanationSchema>
type SolutionBody = z.infer<typeof solutionSchema>
type FailBody = z.infer<typeof failSchema>

export async function handleFail(
  db: Db,
  jobId: string,
  job: Job,
  body: FailBody,
): Promise<NextResponse> {
  const {permanent} = await failJob(db, jobId, body.message)

  if (permanent) {
    await applyPermanentFailure(db, job)
  }

  return NextResponse.json({ok: true, permanent})
}

export async function handlePhase(
  db: Db,
  jobId: string,
  job: Job,
  body: PhaseBody,
): Promise<NextResponse> {
  await runRepairPasses(db, job.worksheetId, {
    only: body.phase === 'classifying' ? FINAL_PASSES : VERIFYING_PASSES,
  })

  await checkpointJob(
    db,
    jobId,
    body.phase === 'classifying' ? CLASSIFYING_AT : VERIFYING_AT,
    job.checkpoint ?? {},
  )

  return NextResponse.json({ok: true})
}

export async function handlePageReview(
  db: Db,
  job: Job,
  body: PageReviewBody,
): Promise<NextResponse> {
  const [target] = await db
    .select({
      id: worksheetPages.id,
      worksheetId: worksheetPages.worksheetId,
      ocrText: worksheetPages.ocrText,
    })
    .from(worksheetPages)
    .where(eq(worksheetPages.id, body.pageId))
    .limit(1)

  if (!target || target.worksheetId !== job.worksheetId) {
    return NextResponse.json({error: 'Page does not belong to this job'}, {status: 400})
  }

  const doubted = body.replace.length
    ? await db
        .select({id: questions.id, printedNumber: questions.printedNumber})
        .from(questions)
        .where(
          and(eq(questions.worksheetId, job.worksheetId), inArray(questions.id, body.replace)),
        )
    : []

  const {removable: suspects, held} = await partitionByDeletability(db, doubted)

  if (held.length > 0) {
    console.log(
      `[review] kept ${held.length} doubted question(s) on ${job.worksheetId}: ` +
        'somebody has already answered them, and damaged beats absent',
    )
  }

  const plan = planPageReplacement(target.ocrText ?? '', body.questions, suspects)

  if (plan.replace.length > 0) {
    await db.delete(questions).where(
      inArray(
        questions.id,
        plan.replace.map((row) => row.id),
      ),
    )
  }

  const restored = await persistQuestions(db, job, target.id, plan.replacements)

  return NextResponse.json({
    ok: true,
    replaced: plan.replace.length,
    held: held.length,
    kept: plan.keep.length,
    restored,
  })
}

export async function handleExplanation(
  db: Db,
  job: Job,
  body: ExplanationBody,
): Promise<NextResponse> {
  const [question] = await db
    .select({id: questions.id})
    .from(questions)
    .where(and(eq(questions.id, body.questionId), eq(questions.userId, job.userId)))
    .limit(1)

  if (!question) {
    return NextResponse.json({error: 'Question does not belong to this job'}, {status: 400})
  }

  await db.insert(explanations).values({
    questionId: body.questionId,
    attemptId: body.attemptId ?? null,
    bodyMd: body.bodyMd,
    misconceptionNote: body.misconceptionNote ?? null,
    provider: null,
    model: body.model,
  })

  return NextResponse.json({ok: true})
}

export async function handleSolution(
  db: Db,
  jobId: string,
  job: Job,
  body: SolutionBody,
): Promise<NextResponse> {
  const [question] = await db
    .select({
      id: questions.id,
      answerSource: questions.answerSource,
      worksheetId: questions.worksheetId,
    })
    .from(questions)
    .where(and(eq(questions.id, body.questionId), eq(questions.userId, job.userId)))
    .limit(1)

  if (!question || question.worksheetId !== job.worksheetId) {
    return NextResponse.json({error: 'Question does not belong to this job'}, {status: 400})
  }

  const choices = await db
    .select({label: answerChoices.label, text: answerChoices.text})
    .from(answerChoices)
    .where(eq(answerChoices.questionId, body.questionId))
    .orderBy(...CHOICE_ORDER)

  await db
    .insert(questionSolutions)
    .values({
      questionId: body.questionId,
      derivedAnswer: body.answer,
      workingMd: body.workingMd,
      traps: body.traps,
      confidence: body.confidence,
      provider: null,
      model: body.model,
    })
    .onConflictDoNothing({target: questionSolutions.questionId})

  const promoted = await promoteDerivedAnswer(db, {
    questionId: body.questionId,
    answer: body.answer,
    confidence: body.confidence,
    choices,
    answerSource: question.answerSource,
  })

  await touchJob(db, jobId)

  return NextResponse.json({ok: true, promoted})
}

export async function handleComplete(
  db: Db,
  jobId: string,
  job: Job,
): Promise<NextResponse> {
  await completeJob(db, jobId)
  const delivered = await transitionWorksheet(
    db,
    job.worksheetId,
    ['queued', 'processing'],
    {status: 'awaiting_review'},
  )

  if (delivered && job.executor === 'browser') {
    await recordUntagged(db, job.worksheetId, UNTAGGED_REASON.browserPending)
  }

  if (job.stage === 'extract') {
    await enqueueJob(db, {
      worksheetId: job.worksheetId,
      userId: job.userId,
      stage: 'answer_key',
      executor: job.executor,
      priority: 'low',
    })
  }

  return NextResponse.json({ok: true})
}

export async function handlePageResult(
  db: Db,
  jobId: string,
  job: Job,
  body: PageResultBody,
): Promise<NextResponse> {
  const [page] = await db
    .select({id: worksheetPages.id, worksheetId: worksheetPages.worksheetId})
    .from(worksheetPages)
    .where(eq(worksheetPages.id, body.pageId))
    .limit(1)

  if (!page || page.worksheetId !== job.worksheetId) {
    return NextResponse.json({error: 'Page does not belong to this job'}, {status: 400})
  }

  const created = await persistQuestions(db, job, page.id, body.questions)

  const previous = (job.checkpoint as {donePages?: number[]} | null)?.donePages ?? []
  const donePages = [...new Set([...previous, body.pageNumber])].sort((a, b) => a - b)

  await checkpointJob(
    db,
    jobId,
    readingProgress(donePages.length, body.totalPages),
    {donePages, lastPageNumber: Math.max(...donePages)},
  )

  return NextResponse.json({ok: true, created, duplicates: body.questions.length - created})
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export type WorkerAuth =
  | {ok: true}
  | {ok: false; status: 401 | 403; message: string}

export function authenticateWorker(request: Request): WorkerAuth {
  const expected = process.env.WORKER_API_TOKEN
  if (!expected) {
    return {ok: false, status: 403, message: 'Worker API is not configured.'}
  }

  const header = request.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''

  if (!token || !safeEquals(token, expected)) {
    return {ok: false, status: 401, message: 'Bad worker credential.'}
  }

  const configured = (process.env.WORKER_ALLOWED_IPS ?? '').trim()

  if (!configured) {
    return {
      ok: false,
      status: 403,
      message:
        'WORKER_ALLOWED_IPS is not set. List the worker addresses, or set it to * to allow any.',
    }
  }

  if (configured !== '*') {
    const allowed = configured
      .split(',')
      .map((ip) => ip.trim())
      .filter(Boolean)

    const ip = clientIp(request.headers)
    if (!ip || !allowed.includes(ip)) {
      return {ok: false, status: 403, message: 'Worker credential not valid from here.'}
    }
  }

  return {ok: true}
}

const SOLVE_BATCH = 25

export async function drainServerQueue(db: Db, limit = 1): Promise<void> {
  for (let i = 0; i < limit; i += 1) {
    let job
    try {
      job = await claimJob(db, 'server')
    } catch (error) {
      console.error('[server-job] could not claim:', (error as Error).message)
      return
    }

    if (!job) return

    await runOneServerJob(db, job)
  }
}

async function runOneServerJob(db: Db, job: ClaimedJob): Promise<void> {
  const {provider, executor} = await resolveProvider(db, job.userId)

  if (executor !== 'server') {
    await failJob(
      db,
      job.id,
      'No cloud API key is configured for this account anymore.',
      true,
    )
    await transitionWorksheet(db, job.worksheetId, ['queued', 'processing'], {
      status: 'failed',
    })
    return
  }

  if (job.stage === 'answer_key') {
    await runSolvingJob(db, provider, job)
    return
  }

  if (job.stage !== 'extract') {
    await failJob(
      db,
      job.id,
      `The server runner has no ${job.stage} stage. Nothing should have enqueued this.`,
      true,
    )
    return
  }

  try {
    await runExtraction(db, provider, job)

    await runRepairPasses(db, job.worksheetId)

    const [worksheet] = await db
      .select({subjectHint: worksheets.subjectHint})
      .from(worksheets)
      .where(eq(worksheets.id, job.worksheetId))
      .limit(1)

    try {
      const {classified, coarse, failed} = await classifyWorksheet(
        db,
        provider,
        job.worksheetId,
        worksheet?.subjectHint,
      )

      console.log(
        `[server-job] classified ${classified} question(s) on ${job.worksheetId}` +
          `${coarse > 0 ? `, ${coarse} raised a topic proposal` : ''}` +
          `${failed > 0 ? `, ${failed} failed` : ''}`,
      )
    } catch (error) {
      if (error instanceof EmbeddingUnavailableError) {
        await handOverClassification(db, job)

        console.error(
          `[server-job] the embedding model will not load on this host: ${error.message}. ` +
            `Worksheet ${job.worksheetId} is extracted but untagged, and so is every ` +
            `other one until it loads. Sorting is queued for the operator GPU, and ` +
            `the student can still do it in their browser.`,
        )
      } else {
        await recordUntagged(db, job.worksheetId, UNTAGGED_REASON.classifierFailed)

        console.error(
          `[server-job] classification failed on ${job.worksheetId}:`,
          (error as Error).message,
        )
      }
    }

    await transitionWorksheet(db, job.worksheetId, ['queued', 'processing'], {
      status: 'awaiting_review',
    })

    await completeJob(db, job.id)

    await enqueueJob(db, {
      worksheetId: job.worksheetId,
      userId: job.userId,
      stage: 'answer_key',
      executor: 'server',
      priority: 'low',
    })
  } catch (error) {
    const {permanent} = await failJob(db, job.id, (error as Error).message)
    if (permanent) {
      await transitionWorksheet(db, job.worksheetId, ['queued', 'processing'], {
        status: 'failed',
      })
    }
  }
}

async function handOverClassification(
  db: Db,
  job: {worksheetId: string; userId: string},
): Promise<void> {
  await recordUntagged(db, job.worksheetId, UNTAGGED_REASON.workerQueued)

  await enqueueJob(db, {
    worksheetId: job.worksheetId,
    userId: job.userId,
    stage: 'classify',
    executor: 'operator_gpu',
    priority: 'low',
  })
}

async function runSolvingJob(
  db: Db,
  provider: AIProvider,
  job: {id: string; worksheetId: string; userId: string},
): Promise<void> {
  try {
    const progress = await deriveSolutions(db, provider, job.worksheetId, SOLVE_BATCH)

    await completeJob(db, job.id)

    const attempted = progress.solved + progress.refused + progress.failed

    console.log(
      `[server-job] solved ${progress.solved} of ${attempted} on ${job.worksheetId}` +
        `${progress.promoted > 0 ? `, ${progress.promoted} promoted to the answer` : ''}` +
        `${progress.refused > 0 ? `, ${progress.refused} declined` : ''}`,
    )

    if (attempted >= SOLVE_BATCH && progress.solved + progress.refused > 0) {
      await enqueueJob(db, {
        worksheetId: job.worksheetId,
        userId: job.userId,
        stage: 'answer_key',
        executor: 'server',
        priority: 'low',
      })
    }
  } catch (error) {
    const {permanent} = await failJob(db, job.id, (error as Error).message)

    console.error(
      `[server-job] solving failed on ${job.worksheetId}` +
        `${permanent ? ' (permanently)' : ''}:`,
      (error as Error).message,
    )
  }
}
