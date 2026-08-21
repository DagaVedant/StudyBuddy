import {after, NextResponse} from 'next/server'
import {and, asc, count, desc, eq, inArray, sql} from 'drizzle-orm'
import {z} from 'zod'

import {
  MAX_DECODED_PIXELS,
  MAX_PAGE_BYTES,
  MAX_PAGE_DIMENSION,
  MAX_PAGES_PER_UPLOAD,
  MAX_SOURCE_PAGE_NUMBER,
  pageCapFor,
} from '@/lib/upload'
import {answerChoices, attempts, processingJobs, questions, questionTopics, reviewCards, reviewLogs, worksheetPages, worksheets} from '@/lib/schema'
import {
  applyClassification,
  isEmbedding,
  pendingQuestionCount,
  pendingQuestions,
  shortlistByVector,
} from '@/lib/taxonomy'
import {
  checkReferences,
  CHOICE_ORDER,
  referenceError,
  unverifyQuestions,
  verifyRemaining,
} from '@/lib/questions/queries'
import {
  claimWorksheetForCompletion,
  claimWorksheetForManualFallback,
  enqueueJob,
  guardWorksheet,
  inFlightExtractCount,
  MAX_IN_FLIGHT_EXTRACTS,
  sweepAbandonedUploads,
  transitionWorksheet,
  workerStatus,
} from '@/lib/queue'
import {
  consumeRateLimit,
  endpoints,
  guardRateLimit,
  PAGE_UPLOAD_LIMIT,
  QUESTION_WRITE_LIMIT,
  UPLOAD_LIMIT,
  WORKSHEET_WRITE_LIMIT,
} from '@/lib/api'
import {
  consumeTrial,
  resolveProvider,
  trialExtractionsToday,
} from '@/lib/ai/resolve'
import {
  correctMarkupAttempt,
  scheduleFromOutcome,
  type StoredCard,
} from '@/lib/review'
import {applyPermanentFailure, clearUntagged} from '@/lib/worker/apply'
import {auth} from '@/auth'
import {classificationSchema, trialDailyCeiling} from '@/lib/ai/types'
import {db} from '@/lib/db'
import {drainServerQueue} from '@/lib/worker/jobs'
import {hashQuestion, questionInputSchema} from '@/lib/questions/shape'
import {ollamaConfig} from '@/lib/ai/ollama'
import {pageImageKey, storage} from '@/lib/queue'
import {roundLines} from '@/lib/questions/shape'

export const maxDuration = 300
const markSchema = z.object({
  marks: z
    .array(
      z.object({
        questionId: z.string().min(1),
        outcome: z.enum(['correct', 'unsure', 'wrong']),
        selectedChoiceId: z.string().min(1).nullish(),
        freeTextAnswer: z.string().trim().max(2000).nullish(),
      }),
    )
    .min(1)
    .max(500),
})

const correctionSchema = z.object({
  questionId: z.string().min(1),
  outcome: z.enum(['correct', 'unsure', 'wrong']),
  selectedChoiceId: z.string().min(1).nullish(),
  freeTextAnswer: z.string().trim().max(2000).nullish(),
})

async function patchIdAttempts(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const {id: worksheetId} = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({error: 'Not found'}, {status: guard.status})
  }

  const parsed = correctionSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const limited = await guardRateLimit(
    db,
    WORKSHEET_WRITE_LIMIT,
    `user:${guard.userId}`,
    'Too many changes to your worksheets. Try again shortly.',
  )
  if (limited) return limited

  const result = await correctMarkupAttempt(db, guard.userId, worksheetId, parsed.data)

  if (!result.ok) {
    return NextResponse.json(
      {
        error:
          result.reason === 'not-marked'
            ? 'This question has not been marked yet'
            : 'No matching question',
      },
      {status: 404},
    )
  }

  return NextResponse.json({ok: true, outcome: result.outcome})
}

async function postIdAttempts(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const {id: worksheetId} = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({error: 'Not found'}, {status: guard.status})
  }

  const parsed = markSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const limited = await guardRateLimit(
    db,
    WORKSHEET_WRITE_LIMIT,
    `user:${guard.userId}`,
    'Too many changes to your worksheets. Try again shortly.',
  )
  if (limited) return limited

  const {marks} = parsed.data
  const questionIds = marks.map((mark) => mark.questionId)

  const owned = await db
    .select({id: questions.id})
    .from(questions)
    .where(
      and(
        eq(questions.worksheetId, worksheetId),
        inArray(questions.id, questionIds),
      ),
    )

  const ownedIds = new Set(owned.map((row) => row.id))
  const accepted = marks.filter((mark) => ownedIds.has(mark.questionId))

  if (accepted.length === 0) {
    return NextResponse.json({error: 'No matching questions'}, {status: 400})
  }

  const [already] = await db
    .select({id: attempts.id})
    .from(attempts)
    .innerJoin(questions, eq(questions.id, attempts.questionId))
    .where(
      and(
        eq(questions.worksheetId, worksheetId),
        eq(attempts.userId, guard.userId),
        eq(attempts.source, 'markup'),
      ),
    )
    .limit(1)

  if (already) {
    return NextResponse.json(
      {error: 'This worksheet was already marked', next: '/dashboard'},
      {status: 409},
    )
  }

  const validChoices = await db
    .select({id: answerChoices.id, questionId: answerChoices.questionId})
    .from(answerChoices)
    .where(inArray(answerChoices.questionId, [...ownedIds]))

  const choiceOwner = new Map(validChoices.map((row) => [row.id, row.questionId]))
  const now = new Date()

  await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(reviewCards)
      .where(
        and(
          eq(reviewCards.userId, guard.userId),
          inArray(reviewCards.questionId, [...ownedIds]),
        ),
      )

    const cardByQuestion = new Map(existing.map((card) => [card.questionId, card]))

    const scheduled = accepted.map((mark) => {
      const current = cardByQuestion.get(mark.questionId)
      const stored: StoredCard | null = current
        ? {
            dueAt: current.dueAt,
            stability: current.stability,
            difficulty: current.difficulty,
            elapsedDays: current.elapsedDays,
            scheduledDays: current.scheduledDays,
            learningSteps: current.learningSteps,
            reps: current.reps,
            lapses: current.lapses,
            state: current.state,
            lastReview: current.lastReview,
          }
        : null

      return {mark, ...scheduleFromOutcome(stored, mark.outcome, now)}
    })

    await tx
      .insert(attempts)
      .values(
        accepted.map((mark) => ({
          userId: guard.userId,
          questionId: mark.questionId,
          outcome: mark.outcome,
          selectedChoiceId:
            mark.selectedChoiceId &&
            choiceOwner.get(mark.selectedChoiceId) === mark.questionId
              ? mark.selectedChoiceId
              : null,
          freeTextAnswer: mark.freeTextAnswer ?? null,
          source: 'markup' as const,
        })),
      )
      .onConflictDoNothing()

    const saved = await tx
      .insert(reviewCards)
      .values(
        scheduled.map(({mark, card}) => ({
          userId: guard.userId,
          questionId: mark.questionId,
          ...card,
        })),
      )
      .onConflictDoUpdate({
        target: [reviewCards.userId, reviewCards.questionId],
        set: {
          dueAt: sql`excluded.due_at`,
          stability: sql`excluded.stability`,
          difficulty: sql`excluded.difficulty`,
          elapsedDays: sql`excluded.elapsed_days`,
          scheduledDays: sql`excluded.scheduled_days`,
          learningSteps: sql`excluded.learning_steps`,
          reps: sql`excluded.reps`,
          lapses: sql`excluded.lapses`,
          state: sql`excluded.state`,
          lastReview: sql`excluded.last_review`,
        },
      })
      .returning({id: reviewCards.id, questionId: reviewCards.questionId})

    const cardIdByQuestion = new Map(saved.map((row) => [row.questionId, row.id]))

    const logs = scheduled
      .map(({mark, log}) => {
        const cardId = cardIdByQuestion.get(mark.questionId)
        if (!cardId) return null
        return {
          cardId,
          rating: log.rating,
          state: log.state,
          elapsedDays: log.elapsedDays,
          scheduledDays: log.scheduledDays,
        }
      })
      .filter((row) => row !== null)

    if (logs.length > 0) await tx.insert(reviewLogs).values(logs)
  })

  return NextResponse.json({ok: true, recorded: accepted.length, next: '/dashboard'})
}

const verifyAllSchema = z.object({
  exclude: z.array(z.string().min(1).max(64)).max(500).optional(),
})

async function postIdCheckAll(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const {id: worksheetId} = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({error: 'Not found'}, {status: guard.status})
  }

  const parsed = verifyAllSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const limited = await guardRateLimit(
    db,
    WORKSHEET_WRITE_LIMIT,
    `user:${guard.userId}`,
    'Too many changes to your worksheets. Try again shortly.',
  )
  if (limited) return limited

  const updated = await verifyRemaining(db, worksheetId, parsed.data.exclude ?? [])

  return NextResponse.json({verified: updated.length})
}

const unverifySchema = z.object({ids: z.array(z.string().min(1).max(64)).min(1).max(500)})

async function deleteIdCheckAll(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const {id: worksheetId} = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({error: 'Not found'}, {status: guard.status})
  }

  const parsed = unverifySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const limited = await guardRateLimit(
    db,
    WORKSHEET_WRITE_LIMIT,
    `user:${guard.userId}`,
    'Too many changes to your worksheets. Try again shortly.',
  )
  if (limited) return limited

  const updated = await unverifyQuestions(db, worksheetId, parsed.data.ids)

  return NextResponse.json({unverified: updated.length})
}

export const BROWSER_CLASSIFY_BATCH = 12

const itemsSchema = z
  .array(
    z.object({questionId: z.string().min(1), embedding: z.array(z.number())}),
  )
  .max(BROWSER_CLASSIFY_BATCH)

const candidateSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
})

const schema = z.union([
  z.object({action: z.literal('shortlist'), items: itemsSchema}),
  z.object({
    action: z.literal('apply'),
    results: z
      .array(
        z.object({
          questionId: z.string().min(1),
          classification: classificationSchema,
          candidates: z.array(candidateSchema).max(64),
          }),
      )
      .max(BROWSER_CLASSIFY_BATCH),
  }),
  z.object({items: itemsSchema}),
])

type Body = z.infer<typeof schema>

async function ownedQuestion(worksheetId: string, userId: string, questionId: string) {
  const [question] = await db
    .select({id: questions.id, promptText: questions.promptText, userId: questions.userId})
    .from(questions)
    .where(
      and(
        eq(questions.id, questionId),
        eq(questions.worksheetId, worksheetId),
        eq(questions.userId, userId),
      ),
    )
    .limit(1)

  return question
}

async function finish(worksheetId: string) {
  const remaining = await pendingQuestions(db, worksheetId, 1)

  if (remaining.length === 0) {
    await clearUntagged(db, worksheetId)
  }

  return remaining.length === 0
}

async function getIdClassify(_request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const {id: worksheetId} = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({error: 'Not found'}, {status: guard.status})
  }

  const {executor} = await resolveProvider(db, guard.userId)

  const pending = await pendingQuestions(db, worksheetId, BROWSER_CLASSIFY_BATCH)
  const remaining = await pendingQuestionCount(db, worksheetId)

  if (remaining === 0) {
    await clearUntagged(db, worksheetId)
  }

  return NextResponse.json({
    supported: executor === 'server' || executor === 'browser',
    executor,
    batchSize: BROWSER_CLASSIFY_BATCH,
    remaining,
    questions: pending,
    ollama: executor === 'browser' ? await ollamaConfig(db, guard.userId) : null,
  })
}

async function postIdClassify(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const {id: worksheetId} = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({error: 'Not found'}, {status: guard.status})
  }

  const parsed = schema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const body: Body = parsed.data
  const {provider, executor} = await resolveProvider(db, guard.userId)

  const [worksheet] = await db
    .select({subjectHint: worksheets.subjectHint})
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  if (!worksheet) {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  if ('action' in body) {
    if (executor !== 'browser') {
      return NextResponse.json(
        {
          error:
            'Picking the topic on this machine is for accounts running their own Ollama.',
        },
        {status: 409},
      )
    }

    if (body.action === 'shortlist') {
      const batch = []

      for (const item of body.items) {
        if (!isEmbedding(item.embedding)) continue

        const question = await ownedQuestion(worksheetId, guard.userId, item.questionId)
        if (!question) continue

        await db
          .update(questions)
          .set({embedding: item.embedding})
          .where(eq(questions.id, question.id))

        batch.push({
          questionId: question.id,
          promptText: question.promptText,
          candidates: await shortlistByVector(db, item.embedding, {
            subjectHint: worksheet.subjectHint,
          }),
        })
      }

      return NextResponse.json({batch})
    }

    let applied = 0
    let coarse = 0
    let failed = 0

    for (const entry of body.results) {
      const question = await ownedQuestion(worksheetId, guard.userId, entry.questionId)
      if (!question) continue

      try {
        const outcome = await applyClassification(
          db,
          question,
          entry.candidates,
          entry.classification,
        )

        if (outcome.topicId) applied += 1
        if (outcome.coarse) coarse += 1
      } catch (error) {
        failed += 1
        console.error(
          `[classify] question ${question.id} could not be tagged:`,
          (error as Error).message,
        )
      }
    }

    return NextResponse.json({applied, coarse, failed, done: await finish(worksheetId)})
  }

  if (executor !== 'server') {
    return NextResponse.json(
      {
        error:
          'Sorting questions into topics needs a cloud API key or your own Ollama. Add one in settings.',
      },
      {status: 409},
    )
  }

  let applied = 0
  let coarse = 0
  let failed = 0

  for (const item of body.items) {
    if (!isEmbedding(item.embedding)) {
      failed += 1
      continue
    }

    const question = await ownedQuestion(worksheetId, guard.userId, item.questionId)
    if (!question) continue

    await db
      .update(questions)
      .set({embedding: item.embedding})
      .where(eq(questions.id, question.id))

    const candidates = await shortlistByVector(db, item.embedding, {
      subjectHint: worksheet.subjectHint,
    })

    if (candidates.length === 0) {
      failed += 1
      continue
    }

    try {
      const classification = await provider.classifyTopic(
        question.promptText,
        candidates,
      )

      const outcome = await applyClassification(
        db,
        question,
        candidates,
        classification,
      )

      if (outcome.topicId) applied += 1
      if (outcome.coarse) coarse += 1
    } catch (error) {
      failed += 1
      console.error(
        `[classify] question ${question.id} could not be classified:`,
        (error as Error).message,
      )
    }
  }

  return NextResponse.json({applied, coarse, failed, done: await finish(worksheetId)})
}

const claimForCompletion = (
  worksheetId: string,
  status: 'queued' | 'awaiting_review',
  tierUsed: 'trial' | 'free' | 'cloud' | 'ollama',
) => claimWorksheetForCompletion(db, worksheetId, status, tierUsed)

async function alreadyCompleted(worksheetId: string) {
  const [current] = await db
    .select({status: worksheets.status, tierUsed: worksheets.tierUsed})
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  const queued = current?.status === 'queued' || current?.status === 'processing'

  return NextResponse.json({
    ok: true,
    tier: current?.tierUsed ?? null,
    mode: queued ? 'queued' : 'manual',
    alreadyCompleted: true,
    next: queued
      ? `/worksheets/${worksheetId}/status`
      : `/worksheets/${worksheetId}/edit`,
  })
}

async function postIdComplete(_request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const {id: worksheetId} = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({error: 'Not found'}, {status: guard.status})
  }

  const limited = await guardRateLimit(
    db,
    WORKSHEET_WRITE_LIMIT,
    `user:${guard.userId}`,
    'Too many changes to your worksheets. Try again shortly.',
  )
  if (limited) return limited

  const {tier, executor} = await resolveProvider(db, guard.userId)

  if (executor === 'none') {
    if (!(await claimForCompletion(worksheetId, 'awaiting_review', tier))) {
      return alreadyCompleted(worksheetId)
    }

    return NextResponse.json({
      ok: true,
      tier,
      mode: 'manual',
      next: `/worksheets/${worksheetId}/edit`,
    })
  }

  if (executor === 'operator_gpu') {
    if (
      guard.role !== 'admin' &&
      (await inFlightExtractCount(db, guard.userId)) >= MAX_IN_FLIGHT_EXTRACTS
    ) {
      if (!(await claimForCompletion(worksheetId, 'awaiting_review', 'free'))) {
        return alreadyCompleted(worksheetId)
      }

      return NextResponse.json({
        ok: true,
        tier: 'free',
        mode: 'manual',
        message:
          'Another worksheet of yours is still being read. This one was not counted ' +
          'against your trial: add its questions here, or come back once the first finishes.',
        next: `/worksheets/${worksheetId}/edit`,
      })
    }

    if (guard.role !== 'admin') {
      const ceiling = trialDailyCeiling()

      if ((await trialExtractionsToday(db)) >= ceiling) {
        if (!(await claimForCompletion(worksheetId, 'awaiting_review', 'free'))) {
          return alreadyCompleted(worksheetId)
        }

        return NextResponse.json({
          ok: true,
          tier: 'free',
          mode: 'manual',
          message:
            'The free trial has hit its limit for today, so this one was not counted ' +
            'against yours. Add its questions here, come back tomorrow, or connect ' +
            'your own AI in settings.',
          next: `/worksheets/${worksheetId}/edit`,
        })
      }
    }

    if (!(await claimForCompletion(worksheetId, 'queued', 'trial'))) {
      return alreadyCompleted(worksheetId)
    }

    const charge =
      guard.role === 'admin'
        ? ({ok: true, remaining: Number.POSITIVE_INFINITY} as const)
        : await consumeTrial(db, guard.userId, 'worksheets', 1)

    if (!charge.ok) {
      await transitionWorksheet(db, worksheetId, ['queued'], {
        status: 'awaiting_review',
        tierUsed: 'free',
      })

      return NextResponse.json({
        ok: true,
        tier: 'free',
        mode: 'manual',
        message: charge.reason,
        next: `/worksheets/${worksheetId}/edit`,
      })
    }

    await enqueueJob(db, {
      worksheetId,
      userId: guard.userId,
      stage: 'extract',
      executor: 'operator_gpu',

      priority: guard.role === 'admin' ? 'low' : 'normal',
    })

    const worker = await workerStatus(db)

    return NextResponse.json({
      ok: true,
      tier: 'trial',
      mode: 'queued',
      workerOnline: worker.online,
      trialWorksheetsRemaining: Number.isFinite(charge.remaining)
        ? charge.remaining
        : null,
      next: `/worksheets/${worksheetId}/status`,
    })
  }

  if (executor === 'browser') {
    if (!(await claimForCompletion(worksheetId, 'queued', tier))) {
      return alreadyCompleted(worksheetId)
    }

    await enqueueJob(db, {
      worksheetId,
      userId: guard.userId,
      stage: 'extract',
      executor: 'browser',
      priority: guard.role === 'admin' ? 'low' : 'normal',
    })

    return NextResponse.json({
      ok: true,
      tier,
      mode: 'browser',
      next: `/worksheets/${worksheetId}/status`,
    })
  }

  if (!(await claimForCompletion(worksheetId, 'queued', tier))) {
    return alreadyCompleted(worksheetId)
  }

  await enqueueJob(db, {
    worksheetId,
    userId: guard.userId,
    stage: 'extract',
    executor: 'server',
    priority: guard.role === 'admin' ? 'low' : 'normal',
  })

  after(() =>
    drainServerQueue(db).catch((error: unknown) => {
      console.error('[server-job] drain failed:', (error as Error).message)
    }),
  )

  return NextResponse.json({
    ok: true,
    tier,
    mode: 'queued',
    next: `/worksheets/${worksheetId}/status`,
  })
}

async function postIdConfirm(_request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const {id: worksheetId} = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({error: 'Not found'}, {status: guard.status})
  }

  const limited = await guardRateLimit(
    db,
    WORKSHEET_WRITE_LIMIT,
    `user:${guard.userId}`,
    'Too many changes to your worksheets. Try again shortly.',
  )
  if (limited) return limited

  const [tally] = await db
    .select({value: count()})
    .from(questions)
    .where(eq(questions.worksheetId, worksheetId))

  if (!tally || tally.value === 0) {
    return NextResponse.json(
      {error: 'Add at least one question before continuing.'},
      {status: 400},
    )
  }

  await db
    .update(questions)
    .set({userVerified: true})
    .where(eq(questions.worksheetId, worksheetId))

  const next = `/worksheets/${worksheetId}/markup`

  if (await transitionWorksheet(db, worksheetId, ['awaiting_review'], {status: 'ready'})) {
    return NextResponse.json({ok: true, next})
  }

  const [current] = await db
    .select({status: worksheets.status})
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  if (current?.status === 'ready') {
    return NextResponse.json({ok: true, next})
  }

  return NextResponse.json(
    {error: 'This worksheet is not ready to confirm.'},
    {status: 409},
  )
}

async function postIdGoManual(_request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const {id: worksheetId} = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({error: 'Not found'}, {status: guard.status})
  }

  const limited = await guardRateLimit(
    db,
    WORKSHEET_WRITE_LIMIT,
    `user:${guard.userId}`,
    'Too many changes to your worksheets. Try again shortly.',
  )
  if (limited) return limited

  const won = await claimWorksheetForManualFallback(db, worksheetId)
  if (!won) {
    return NextResponse.json({ok: true, next: `/worksheets/${worksheetId}/edit`})
  }

  const openJobs = await db
    .select({id: processingJobs.id, stage: processingJobs.stage})
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.worksheetId, worksheetId),
        inArray(processingJobs.status, ['pending', 'claimed', 'running']),
      ),
    )

  for (const job of openJobs) {
    await db
      .update(processingJobs)
      .set({
        status: 'cancelled',
        error: 'The student chose to enter questions manually rather than wait.',
      })
      .where(eq(processingJobs.id, job.id))
  }

  await applyPermanentFailure(db, {
    stage: openJobs.find((job) => job.stage === 'extract')?.stage ?? 'extract',
    userId: guard.userId,
    worksheetId,
  })

  return NextResponse.json({ok: true, next: `/worksheets/${worksheetId}/edit`})
}

async function getIdPagesPageidLines(_request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const {id: worksheetId, pageId} = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({error: 'Not found'}, {status: guard.status})
  }

  const [row] = await db
    .select({textLines: worksheetPages.textLines})
    .from(worksheetPages)
    .where(and(eq(worksheetPages.id, pageId), eq(worksheetPages.worksheetId, worksheetId)))
    .limit(1)

  if (!row) {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  return NextResponse.json({textLines: roundLines(row.textLines)})
}

async function postIdPages(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const {id: worksheetId} = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({error: 'Not found'}, {status: guard.status})
  }

  const allowance = await consumeRateLimit(
    db,
    PAGE_UPLOAD_LIMIT,
    `user:${guard.userId}`,
  )

  if (!allowance.ok) {
    return NextResponse.json(
      {error: "That's a lot of pages in one go. Try again shortly."},
      {status: 429, headers: {'Retry-After': String(allowance.retryAfter)}},
    )
  }

  const form = await request.formData().catch(() => null)
  if (!form) {
    return NextResponse.json({error: 'Missing image'}, {status: 400})
  }

  const file = form.get('image')
  const pageNumber = Number(form.get('pageNumber'))

  if (!(file instanceof File)) {
    return NextResponse.json({error: 'Missing image'}, {status: 400})
  }

  if (
    !Number.isInteger(pageNumber) ||
    pageNumber < 1 ||
    pageNumber > MAX_SOURCE_PAGE_NUMBER
  ) {
    return NextResponse.json({error: 'Invalid page number'}, {status: 400})
  }

  if (file.size > MAX_PAGE_BYTES) {
    return NextResponse.json({error: 'Page image is too large'}, {status: 413})
  }

  const [sheet] = await db
    .select({pageCount: worksheets.pageCount, status: worksheets.status})
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  if (!sheet) {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  const stored = await db
    .select({pageNumber: worksheetPages.pageNumber})
    .from(worksheetPages)
    .where(eq(worksheetPages.worksheetId, worksheetId))

  const replacing = stored.some((row) => row.pageNumber === pageNumber)
  if (!replacing && stored.length >= sheet.pageCount) {
    return NextResponse.json(
      {error: 'That is more pages than this worksheet was created for.'},
      {status: 409},
    )
  }

  let encoded: Buffer
  let realWidth: number
  let realHeight: number

  const {default: sharp} = await import('sharp')

  try {
    const result = await sharp(Buffer.from(await file.arrayBuffer()), {
      limitInputPixels: MAX_DECODED_PIXELS,
    })
      .rotate()
      .webp({quality: 82})
      .toBuffer({resolveWithObject: true})

    encoded = result.data
    realWidth = result.info.width
    realHeight = result.info.height
  } catch {
    return NextResponse.json({error: 'Not an image'}, {status: 415})
  }

  if (realWidth > MAX_PAGE_DIMENSION || realHeight > MAX_PAGE_DIMENSION) {
    return NextResponse.json({error: 'Page image is too large'}, {status: 413})
  }

  const key = pageImageKey(worksheetId, pageNumber)
  await storage.put(key, encoded, 'image/webp')

  const [page] = await db
    .insert(worksheetPages)
    .values({worksheetId, pageNumber, imageKey: key, width: realWidth, height: realHeight})
    .onConflictDoUpdate({
      target: [worksheetPages.worksheetId, worksheetPages.pageNumber],
      set: {imageKey: key, width: realWidth, height: realHeight},
    })
    .returning({id: worksheetPages.id})

  if (sheet.status === 'uploading' || sheet.status === 'processing') {
    await db
      .update(worksheets)
      .set({status: 'processing'})
      .where(
        and(
          eq(worksheets.id, worksheetId),
          inArray(worksheets.status, ['uploading', 'processing']),
        ),
      )
  }

  return NextResponse.json({pageId: page.id, imageKey: key}, {status: 201})
}

const bboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()])

const ocrSchema = z.object({
  pageId: z.string().min(1),
  ocrText: z.string().max(200_000),
  ocrEngine: z.enum(['pdf_text', 'tesseract', 'vision']),
  textLines: z
    .array(z.object({text: z.string().max(2000), bbox: bboxSchema}))
    .max(4000)
    .optional(),
})

async function patchIdPages(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const {id: worksheetId} = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({error: 'Not found'}, {status: guard.status})
  }

  const parsed = ocrSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const {pageId, ocrText, ocrEngine, textLines} = parsed.data

  await db
    .update(worksheetPages)
    .set({ocrText, ocrEngine, textLines: textLines ?? null})
    .where(
      and(
        eq(worksheetPages.id, pageId),
        eq(worksheetPages.worksheetId, worksheetId),
      ),
    )

  return NextResponse.json({ok: true})
}

async function getIdQuestions(_request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const {id: worksheetId} = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({error: 'Not found'}, {status: guard.status})
  }

  const rows = await db
    .select()
    .from(questions)
    .where(eq(questions.worksheetId, worksheetId))
    .orderBy(asc(questions.ordinal))

  const choices = await db
    .select()
    .from(answerChoices)
    .innerJoin(questions, eq(answerChoices.questionId, questions.id))
    .where(eq(questions.worksheetId, worksheetId))
    .orderBy(...CHOICE_ORDER)

  const topics = await db
    .select()
    .from(questionTopics)
    .innerJoin(questions, eq(questionTopics.questionId, questions.id))
    .where(eq(questions.worksheetId, worksheetId))

  const choicesFor = new Map<string, (typeof choices)[number]['answer_choices'][]>()
  for (const row of choices) {
    const list = choicesFor.get(row.answer_choices.questionId)
    if (list) list.push(row.answer_choices)
    else choicesFor.set(row.answer_choices.questionId, [row.answer_choices])
  }

  const topicFor = new Map<string, string>()
  for (const row of topics) {
    if (!topicFor.has(row.question_topics.questionId)) {
      topicFor.set(row.question_topics.questionId, row.question_topics.topicId)
    }
  }

  return NextResponse.json({
    questions: rows.map((question) => ({
      ...question,
      choices: choicesFor.get(question.id) ?? [],
      topicId: topicFor.get(question.id) ?? null,
    })),
  })
}

async function postIdQuestions(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const {id: worksheetId} = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({error: 'Not found'}, {status: guard.status})
  }

  const allowance = await consumeRateLimit(db, QUESTION_WRITE_LIMIT, `user:${guard.userId}`)

  if (!allowance.ok) {
    return NextResponse.json(
      {error: "That's a lot of questions in one go. Try again shortly."},
      {status: 429, headers: {'Retry-After': String(allowance.retryAfter)}},
    )
  }

  const parsed = questionInputSchema.safeParse(
    await request.json().catch(() => null),
  )
  if (!parsed.success) {
    return NextResponse.json(
      {error: parsed.error.issues[0]?.message ?? 'Invalid question'},
      {status: 400},
    )
  }

  const input = parsed.data
  const choices = input.choices ?? []

  const references = await checkReferences(db, worksheetId, input)
  if (!references.ok) {
    return NextResponse.json(
      {error: referenceError(references.field!)},
      {status: 400},
    )
  }

  const contentHash = hashQuestion(input.promptText, choices)

  const questionId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(questions)
      .values({
        userId: guard.userId,
        worksheetId,
        pageId: input.pageId ?? null,
        ordinal: input.ordinal,
        promptText: input.promptText,
        questionType: input.questionType,
        bbox: input.bbox ?? null,
        correctAnswer: input.correctAnswer ?? null,
        answerSource: input.correctAnswer ? 'user_key' : 'none',
        userVerified: true,
        contentHash,
      })
      .returning({id: questions.id})

    if (choices.length > 0) {
      await tx.insert(answerChoices).values(
        choices.map((choice) => ({
          questionId: row.id,
          label: choice.label,
          text: choice.text,
          isCorrect: choice.isCorrect,
        })),
      )
    }

    if (input.topicId) {
      await tx.insert(questionTopics).values({
        questionId: row.id,
        topicId: input.topicId,
        assignedBy: 'user',
        isPrimary: true,
        confidence: 1,
      })
    }

    return row.id
  })

  return NextResponse.json({questionId}, {status: 201})
}

const renameSchema = z.object({title: z.string().trim().min(1).max(200)})

async function patchId(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({error: 'Unauthorized'}, {status: 401})
  }

  const {id} = await params

  const parsed = renameSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      {error: 'A title has to be between 1 and 200 characters.'},
      {status: 400},
    )
  }

  const limited = await guardRateLimit(
    db,
    WORKSHEET_WRITE_LIMIT,
    `user:${session.user.id}`,
    'Too many changes to your worksheets. Try again shortly.',
  )
  if (limited) return limited

  const [updated] = await db
    .update(worksheets)
    .set({title: parsed.data.title})
    .where(and(eq(worksheets.id, id), eq(worksheets.userId, session.user.id)))
    .returning({id: worksheets.id, title: worksheets.title})

  if (!updated) {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  return NextResponse.json({ok: true, title: updated.title})
}

async function deleteId(_request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({error: 'Unauthorized'}, {status: 401})
  }

  const {id} = await params

  const [worksheet] = await db
    .select({userId: worksheets.userId})
    .from(worksheets)
    .where(eq(worksheets.id, id))
    .limit(1)

  if (!worksheet || worksheet.userId !== session.user.id) {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  const limited = await guardRateLimit(
    db,
    WORKSHEET_WRITE_LIMIT,
    `user:${session.user.id}`,
    'Too many changes to your worksheets. Try again shortly.',
  )
  if (limited) return limited

  const pageKeys = await db
    .select({imageKey: worksheetPages.imageKey})
    .from(worksheetPages)
    .where(eq(worksheetPages.worksheetId, id))

  await db.delete(worksheets).where(eq(worksheets.id, id))

  await Promise.allSettled(pageKeys.map((page) => storage.remove(page.imageKey)))

  return NextResponse.json({ok: true})
}
const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  sourceType: z.enum(['pdf_digital', 'pdf_scanned', 'photo', 'image']),
  subjectHint: z.string().trim().max(100).nullish(),
  pageCount: z.number().int().min(1).max(2000),
  expectedQuestionCount: z.number().int().min(1).max(2000).nullish(),
})

async function postRoot(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({error: 'Unauthorized'}, {status: 401})
  }

  const allowance = await consumeRateLimit(
    db,
    UPLOAD_LIMIT,
    `user:${session.user.id}`,
  )

  if (!allowance.ok) {
    return NextResponse.json(
      {error: "That's a lot of uploads in one go. Try again shortly."},
      {status: 429, headers: {'Retry-After': String(allowance.retryAfter)}},
    )
  }

  const parsed = createSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const {title, sourceType, subjectHint, pageCount, expectedQuestionCount} =
    parsed.data

  const cap = pageCapFor(session.user.role)
  if (pageCount > cap) {
    return NextResponse.json(
      {
        error: `That upload is ${pageCount} pages. The limit is ${MAX_PAGES_PER_UPLOAD} pages per upload.`,
      },
      {status: 413},
    )
  }

  const {tier} = await resolveProvider(db, session.user.id)

  const [worksheet] = await db
    .insert(worksheets)
    .values({
      userId: session.user.id,
      title,
      sourceType,
      subjectHint: subjectHint ?? null,
      pageCount,
      expectedQuestionCount: expectedQuestionCount ?? null,
      status: 'uploading',
      tierUsed: tier,
    })
    .returning({id: worksheets.id})

  after(async () => {
    try {
      const swept = await sweepAbandonedUploads(db, session.user.id)
      if (swept > 0) {
        console.log(`[upload] swept ${swept} abandoned upload(s) for ${session.user.id}`)
      }
    } catch (error) {
      console.error('[upload] sweep failed:', (error as Error).message)
    }
  })

  return NextResponse.json({worksheetId: worksheet.id}, {status: 201})
}

async function getRoot() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({error: 'Unauthorized'}, {status: 401})
  }

  const rows = await db
    .select({
      id: worksheets.id,
      title: worksheets.title,
      status: worksheets.status,
      pageCount: worksheets.pageCount,
      createdAt: worksheets.createdAt,
    })
    .from(worksheets)
    .where(eq(worksheets.userId, session.user.id))
    .orderBy(desc(worksheets.createdAt))
    .limit(50)

  return NextResponse.json({worksheets: rows})
}

const handle = endpoints([
  ['POST', ':id/attempts', postIdAttempts], ['PATCH', ':id/attempts', patchIdAttempts],
  ['POST', ':id/check-all', postIdCheckAll], ['DELETE', ':id/check-all', deleteIdCheckAll],
  ['GET', ':id/classify', getIdClassify], ['POST', ':id/classify', postIdClassify],
  ['POST', ':id/complete', postIdComplete], ['POST', ':id/confirm', postIdConfirm],
  ['POST', ':id/go-manual', postIdGoManual],
  ['GET', ':id/pages/:pageId/lines', getIdPagesPageidLines],
  ['POST', ':id/pages', postIdPages], ['PATCH', ':id/pages', patchIdPages],
  ['GET', ':id/questions', getIdQuestions], ['POST', ':id/questions', postIdQuestions],
  ['PATCH', ':id', patchId], ['DELETE', ':id', deleteId], ['GET', '', getRoot],
  ['POST', '', postRoot],
])

export const GET = handle
export const POST = handle
export const PATCH = handle
export const PUT = handle
export const DELETE = handle
