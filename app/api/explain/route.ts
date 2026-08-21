import {NextResponse} from 'next/server'
import {and, desc, eq} from 'drizzle-orm'
import {z} from 'zod'

import {answerChoices, attempts, explanations, processingJobs, questions} from '@/lib/schema'
import {CHOICE_ORDER} from '@/lib/questions/queries'
import {ProviderRefused, ProviderUnavailable} from '@/lib/ai/types'
import {auth} from '@/auth'
import {consumeRateLimit, EXPLAIN_LIMIT} from '@/lib/api'
import {consumeTrial, resolveProvider, storedProvider} from '@/lib/ai/resolve'
import {db} from '@/lib/db'
import {enqueueJob, pendingExplainJob, workerStatus} from '@/lib/queue'

const schema = z.object({questionId: z.string().min(1)})

async function writerStatus(
  jobId: string,
): Promise<{runsHere: boolean; writerOnline: boolean}> {
  const [job] = await db
    .select({executor: processingJobs.executor})
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId))
    .limit(1)

  if (job?.executor === 'browser') return {runsHere: true, writerOnline: true}

  return {runsHere: false, writerOnline: (await workerStatus(db)).online}
}

export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({error: 'Unauthorized'}, {status: 401})
  }

  const questionId = new URL(request.url).searchParams.get('questionId')
  if (!questionId) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const [question] = await db
    .select({id: questions.id})
    .from(questions)
    .where(and(eq(questions.id, questionId), eq(questions.userId, session.user.id)))
    .limit(1)

  if (!question) return NextResponse.json({error: 'Not found'}, {status: 404})

  const [ready] = await db
    .select()
    .from(explanations)
    .where(eq(explanations.questionId, question.id))
    .orderBy(desc(explanations.generatedAt))
    .limit(1)

  if (ready && !ready.reportedWrong) {
    return NextResponse.json({
      status: 'ready',
      explanation: {body: ready.bodyMd, misconception: ready.misconceptionNote},
    })
  }

  const pending = await pendingExplainJob(
    db,
    session.user.id,
    question.id,
  )

  if (!pending) return NextResponse.json({status: 'none'})

  return NextResponse.json({status: 'queued', ...(await writerStatus(pending))})
}

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({error: 'Unauthorized'}, {status: 401})
  }

  const parsed = schema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const userId = session.user.id

  const [question] = await db
    .select()
    .from(questions)
    .where(
      and(eq(questions.id, parsed.data.questionId), eq(questions.userId, userId)),
    )
    .limit(1)

  if (!question) {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  const [cached] = await db
    .select()
    .from(explanations)
    .where(eq(explanations.questionId, question.id))
    .orderBy(desc(explanations.generatedAt))
    .limit(1)

  if (cached && !cached.reportedWrong) {
    return NextResponse.json({
      explanation: {body: cached.bodyMd, misconception: cached.misconceptionNote},
      cached: true,
    })
  }

  const allowance = await consumeRateLimit(db, EXPLAIN_LIMIT, `user:${userId}`)
  if (!allowance.ok) {
    return NextResponse.json(
      {error: 'You have asked for a lot of explanations. Try again shortly.'},
      {status: 429, headers: {'Retry-After': String(allowance.retryAfter)}},
    )
  }

  const choices = await db
    .select()
    .from(answerChoices)
    .where(eq(answerChoices.questionId, question.id))
    .orderBy(...CHOICE_ORDER)

  const [lastAttempt] = await db
    .select()
    .from(attempts)
    .where(and(eq(attempts.userId, userId), eq(attempts.questionId, question.id)))
    .orderBy(desc(attempts.createdAt))
    .limit(1)

  const studentAnswer =
    choices.find((choice) => choice.id === lastAttempt?.selectedChoiceId)?.label ??
    lastAttempt?.freeTextAnswer ??
    null

  const {provider, tier, executor} = await resolveProvider(db, userId)

  if (tier === 'trial' && session.user.role !== 'admin') {
    const charge = await consumeTrial(db, userId, 'explanations', 1)
    if (!charge.ok) {
      return NextResponse.json({error: charge.reason}, {status: 402})
    }
  }

  if (
    executor === 'browser' ||
    (executor === 'operator_gpu' && provider.executionSite === 'none')
  ) {
    const existing = await pendingExplainJob(db, userId, question.id)

    const jobId =
      existing ??
      (await enqueueJob(db, {
        worksheetId: question.worksheetId,
        userId,
        stage: 'explain',
        executor: executor === 'browser' ? 'browser' : 'operator_gpu',
        priority: 'high',
        checkpoint: {questionId: question.id, attemptId: lastAttempt?.id ?? null},
      }))

    return NextResponse.json(
      {status: 'queued', jobId, ...(await writerStatus(jobId))},
      {status: 202},
    )
  }

  try {
    const result = await provider.explain({
      promptText: question.promptText,
      choices: choices.map((choice) => ({label: choice.label, text: choice.text})),
      correctAnswer:
        choices.find((choice) => choice.isCorrect)?.label ?? question.correctAnswer,
      studentAnswer,
    })

    await db.insert(explanations).values({
      questionId: question.id,
      attemptId: lastAttempt?.id ?? null,
      bodyMd: result.body_md,
      misconceptionNote: result.misconception_note,
      provider: storedProvider(provider.name),
      model: provider.model,
    })

    return NextResponse.json({
      explanation: {body: result.body_md, misconception: result.misconception_note},
      cached: false,
    })
  } catch (error) {
    if (error instanceof ProviderUnavailable) {
      return NextResponse.json(
        {
          error:
            'No AI is set up for your account. Add an API key or connect Ollama in settings.',
        },
        {status: 409},
      )
    }

    if (error instanceof ProviderRefused) {
      return NextResponse.json(
        {error: 'The model declined to answer this one.'},
        {status: 422},
      )
    }

    return NextResponse.json(
      {error: 'Could not generate an explanation. Try again.'},
      {status: 502},
    )
  }
}
