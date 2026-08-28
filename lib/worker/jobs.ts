import {timingSafeEqual} from 'node:crypto'

import {NextResponse} from 'next/server'
import {and, eq, inArray} from 'drizzle-orm'
import {z} from 'zod'

import {
  FINAL_PASSES,
  persistQuestions,
  type RepairPass,
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
import {
  type AIProvider,
  extractedQuestionSchema,
  generatedQuestionSchema,
  lessonSchema,
} from '@/lib/ai/types'
import {type Db} from '@/lib/db'
import {resolveProvider} from '@/lib/ai/resolve'
import {acceptPractice, storeLesson} from '@/lib/practice'

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

const lessonResultSchema = z.object({
  action: z.literal('lesson'),
  topicId: z.string().uuid(),
  lesson: lessonSchema,
  model: z.string().max(200),
})

const practiceResultSchema = z.object({
  action: z.literal('practice'),
  topicId: z.string().uuid(),
  count: z.number().int().min(1).max(8),
  questions: z.array(generatedQuestionSchema).max(16),
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
  lessonResultSchema,
  practiceResultSchema,
  completeSchema,
  failSchema,
])

export type Job = typeof processingJobs.$inferSelect

type PageResultBody = z.infer<typeof pageResultSchema>
type PhaseBody = z.infer<typeof phaseSchema>
type PageReviewBody = z.infer<typeof pageReviewSchema>
type ExplanationBody = z.infer<typeof explanationSchema>
type SolutionBody = z.infer<typeof solutionSchema>
type LessonBody = z.infer<typeof lessonResultSchema>
type PracticeBody = z.infer<typeof practiceResultSchema>
type FailBody = z.infer<typeof failSchema>

export async function handleFail(db: Db, jobId: string, job: Job, body: FailBody) {
  const outcome = await failJob(db, jobId, body.message)

  if (outcome.permanent) {
    await applyPermanentFailure(db, job)
  }

  return NextResponse.json({ok: true, permanent: outcome.permanent})
}

export async function handlePhase(db: Db, jobId: string, job: Job, body: PhaseBody) {
  let passes: readonly RepairPass[] = VERIFYING_PASSES
  let progress = VERIFYING_AT

  if (body.phase === 'classifying') {
    passes = FINAL_PASSES
    progress = CLASSIFYING_AT
  }

  await runRepairPasses(db, job.worksheetId, {only: passes})

  let checkpoint = job.checkpoint
  if (!checkpoint) checkpoint = {}

  await checkpointJob(db, jobId, progress, checkpoint)

  return NextResponse.json({ok: true})
}

export async function handlePageReview(db: Db, job: Job, body: PageReviewBody) {
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

  let doubted: {id: string; printedNumber: number | null}[] = []

  if (body.replace.length > 0) {
    doubted = await db
      .select({id: questions.id, printedNumber: questions.printedNumber})
      .from(questions)
      .where(
        and(
          eq(questions.worksheetId, job.worksheetId),
          inArray(questions.id, body.replace),
        ),
      )
  }

  const split = await partitionByDeletability(db, doubted)
  const suspects = split.removable
  const held = split.held

  if (held.length > 0) {
    console.log(
      '[review] kept ' +
        held.length +
        ' doubted question(s) on ' +
        job.worksheetId +
        ': somebody has already answered them, and damaged beats absent',
    )
  }

  let ocrText = ''
  if (target.ocrText) ocrText = target.ocrText

  const plan = planPageReplacement(ocrText, body.questions, suspects)

  if (plan.replace.length > 0) {
    const ids = []
    for (const row of plan.replace) ids.push(row.id)

    await db.delete(questions).where(inArray(questions.id, ids))
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

export async function handleExplanation(db: Db, job: Job, body: ExplanationBody) {
  const [question] = await db
    .select({id: questions.id})
    .from(questions)
    .where(and(eq(questions.id, body.questionId), eq(questions.userId, job.userId)))
    .limit(1)

  if (!question) {
    return NextResponse.json(
      {error: 'Question does not belong to this job'},
      {status: 400},
    )
  }

  let attemptId = null
  if (body.attemptId) attemptId = body.attemptId

  let misconceptionNote = null
  if (body.misconceptionNote) misconceptionNote = body.misconceptionNote

  await db.insert(explanations).values({
    questionId: body.questionId,
    attemptId: attemptId,
    bodyMd: body.bodyMd,
    misconceptionNote: misconceptionNote,
    provider: null,
    model: body.model,
  })

  return NextResponse.json({ok: true})
}

export async function handleLesson(db: Db, job: Job, body: LessonBody) {
  await storeLesson(db, body.topicId, null, body.lesson, body.model)

  return NextResponse.json({ok: true})
}

export async function handlePractice(db: Db, job: Job, body: PracticeBody) {
  const outcome = await acceptPractice(
    db,
    {name: 'operator_gpu', answeringModel: body.model},
    {userId: job.userId, topicId: body.topicId, count: body.count},
    body.questions,
  )

  return NextResponse.json({ok: true, created: outcome.created})
}

export async function handleSolution(
  db: Db,
  jobId: string,
  job: Job,
  body: SolutionBody,
) {
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
    return NextResponse.json(
      {error: 'Question does not belong to this job'},
      {status: 400},
    )
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

export async function handleComplete(db: Db, jobId: string, job: Job) {
  await completeJob(db, jobId)

  if (job.stage === 'lesson' || job.stage === 'practice') {
    return NextResponse.json({ok: true})
  }

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
) {
  const [page] = await db
    .select({id: worksheetPages.id, worksheetId: worksheetPages.worksheetId})
    .from(worksheetPages)
    .where(eq(worksheetPages.id, body.pageId))
    .limit(1)

  if (!page || page.worksheetId !== job.worksheetId) {
    return NextResponse.json({error: 'Page does not belong to this job'}, {status: 400})
  }

  const created = await persistQuestions(db, job, page.id, body.questions)

  const checkpoint = job.checkpoint as {donePages?: number[]} | null

  const seen = new Set<number>()

  if (checkpoint && checkpoint.donePages) {
    for (const pageNumber of checkpoint.donePages) seen.add(pageNumber)
  }

  seen.add(body.pageNumber)

  const donePages: number[] = []
  for (const pageNumber of seen) donePages.push(pageNumber)

  donePages.sort(function (a, b) {
    return a - b
  })

  let lastPageNumber = donePages[0]
  for (const pageNumber of donePages) {
    if (pageNumber > lastPageNumber) lastPageNumber = pageNumber
  }

  await checkpointJob(db, jobId, readingProgress(donePages.length, body.totalPages), {
    donePages,
    lastPageNumber,
  })

  return NextResponse.json({
    ok: true,
    created,
    duplicates: body.questions.length - created,
  })
}

function safeEquals(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)

  if (left.length !== right.length) return false

  return timingSafeEqual(left, right)
}

export type WorkerAuth = {
  ok: boolean
  status: number
  message: string
}

export function authenticateWorker(request: Request): WorkerAuth {
  const expected = process.env.WORKER_API_TOKEN

  if (!expected) {
    return {ok: false, status: 403, message: 'Worker API is not configured.'}
  }

  let header = request.headers.get('authorization')
  if (!header) header = ''

  let token = ''
  if (header.startsWith('Bearer ')) token = header.slice(7)

  if (!token || !safeEquals(token, expected)) {
    return {ok: false, status: 401, message: 'Bad worker credential.'}
  }

  let configured = process.env.WORKER_ALLOWED_IPS
  if (!configured) configured = ''

  configured = configured.trim()

  if (!configured) {
    return {
      ok: false,
      status: 403,
      message:
        'WORKER_ALLOWED_IPS is not set. List the worker addresses, or set it to * to allow any.',
    }
  }

  if (configured !== '*') {
    const allowed: string[] = []

    for (const value of configured.split(',')) {
      const ip = value.trim()
      if (ip) allowed.push(ip)
    }

    const ip = clientIp(request.headers)

    if (!ip || !allowed.includes(ip)) {
      return {ok: false, status: 403, message: 'Worker credential not valid from here.'}
    }
  }

  return {ok: true, status: 200, message: ''}
}

const SOLVE_BATCH = 25

async function handOverClassification(
  db: Db,
  job: {worksheetId: string; userId: string},
) {
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
) {
  try {
    const progress = await deriveSolutions(db, provider, job.worksheetId, SOLVE_BATCH)

    await completeJob(db, job.id)

    const attempted = progress.solved + progress.refused + progress.failed

    let line =
      '[server-job] solved ' +
      progress.solved +
      ' of ' +
      attempted +
      ' on ' +
      job.worksheetId

    if (progress.promoted > 0) {
      line = line + ', ' + progress.promoted + ' promoted to the answer'
    }

    if (progress.refused > 0) {
      line = line + ', ' + progress.refused + ' declined'
    }

    console.log(line)

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
    const outcome = await failJob(db, job.id, (error as Error).message)

    let where = '[server-job] solving failed on ' + job.worksheetId
    if (outcome.permanent) where = where + ' (permanently)'

    console.error(where + ':', (error as Error).message)
  }
}

async function runOneServerJob(db: Db, job: ClaimedJob) {
  const resolved = await resolveProvider(db, job.userId)
  const provider = resolved.provider

  if (resolved.executor !== 'server') {
    await failJob(db, job.id, 'No model is configured for this account anymore.', true)

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
      'The server runner has no ' + job.stage + ' stage. Nothing should have enqueued this.',
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

    let subjectHint = null
    if (worksheet) subjectHint = worksheet.subjectHint

    try {
      const counts = await classifyWorksheet(db, provider, job.worksheetId, subjectHint)

      let line =
        '[server-job] classified ' + counts.classified + ' question(s) on ' + job.worksheetId

      if (counts.coarse > 0) line = line + ', ' + counts.coarse + ' raised a topic proposal'
      if (counts.failed > 0) line = line + ', ' + counts.failed + ' failed'

      console.log(line)
    } catch (error) {
      if (error instanceof EmbeddingUnavailableError) {
        await handOverClassification(db, job)

        console.error(
          '[server-job] the embedding model will not load on this host: ' +
            error.message +
            '. Worksheet ' +
            job.worksheetId +
            ' is extracted but untagged, and so is every other one until it loads. ' +
            'Sorting is queued for the operator GPU, and the student can still do it ' +
            'in their browser.',
        )
      } else {
        await recordUntagged(db, job.worksheetId, UNTAGGED_REASON.classifierFailed)

        console.error(
          '[server-job] classification failed on ' + job.worksheetId + ':',
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
    const outcome = await failJob(db, job.id, (error as Error).message)

    if (outcome.permanent) {
      await transitionWorksheet(db, job.worksheetId, ['queued', 'processing'], {
        status: 'failed',
      })
    }
  }
}

export async function drainServerQueue(db: Db, limit = 1) {
  for (let i = 0; i < limit; i++) {
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
