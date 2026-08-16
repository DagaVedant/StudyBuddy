import { and, desc, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { consumeTrial } from '@/lib/ai/quota'
import { resolveProvider } from '@/lib/ai/resolve'
import { storedProvider } from '@/lib/ai/stored-provider'
import { CHOICE_ORDER } from '@/lib/questions/sql'
import { ProviderRefused, ProviderUnavailable } from '@/lib/ai/types'
import { auth } from '@/auth'
import { db } from '@/lib/db'
import { answerChoices, attempts, explanations, questions } from '@/lib/db/schema'
import { enqueueJob, pendingExplainJob } from '@/lib/queue'
import { EXPLAIN_LIMIT, consumeRateLimit } from '@/lib/rate-limit'

const schema = z.object({ questionId: z.string().min(1) })

/**
 * Whether an explanation has arrived yet.
 *
 * Separate from POST so waiting on a queued job does not spend the request
 * budget: polling through POST would exhaust an hour's allowance in a couple
 * of minutes, and it would also re-charge the trial quota each time.
 */
export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const questionId = new URL(request.url).searchParams.get('questionId')
  if (!questionId) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const [question] = await db
    .select({ id: questions.id })
    .from(questions)
    .where(and(eq(questions.id, questionId), eq(questions.userId, session.user.id)))
    .limit(1)

  if (!question) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const [ready] = await db
    .select()
    .from(explanations)
    .where(eq(explanations.questionId, question.id))
    .orderBy(desc(explanations.generatedAt))
    .limit(1)

  if (ready && !ready.reportedWrong) {
    return NextResponse.json({
      status: 'ready',
      explanation: { body: ready.bodyMd, misconception: ready.misconceptionNote },
    })
  }

  const pending = await pendingExplainJob(
    db,
    session.user.id,
    question.id,
  )

  // Nothing ready and nothing queued means the job failed or was never
  // enqueued; saying so lets the client stop waiting instead of polling on.
  return NextResponse.json({ status: pending ? 'queued' : 'none' })
}

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const parsed = schema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
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
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const [cached] = await db
    .select()
    .from(explanations)
    .where(eq(explanations.questionId, question.id))
    .orderBy(desc(explanations.generatedAt))
    .limit(1)

  if (cached && !cached.reportedWrong) {
    return NextResponse.json({
      explanation: { body: cached.bodyMd, misconception: cached.misconceptionNote },
      cached: true,
    })
  }

  // After the cache lookup, not before it. This limit exists because every
  // explanation past this point is a model call, and it was being charged for
  // reads that are not: re-opening an explanation you already have is a row
  // fetch, and it was spending the same hour's budget as generating one. A
  // student revisiting a worksheet they had already worked through could be
  // told they had asked for too many explanations without having generated a
  // single new one.
  const allowance = await consumeRateLimit(db, EXPLAIN_LIMIT, `user:${userId}`)
  if (!allowance.ok) {
    return NextResponse.json(
      { error: 'You have asked for a lot of explanations. Try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(allowance.retryAfter) } },
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

  const { provider, tier, executor } = await resolveProvider(db, userId)

  if (tier === 'trial' && session.user.role !== 'admin') {
    const charge = await consumeTrial(db, userId, 'explanations', 1)
    if (!charge.ok) {
      return NextResponse.json({ error: charge.reason }, { status: 402 })
    }
  }

  // A trial account's model is the operator's GPU, which sits behind a home
  // connection and only ever dials out; this server cannot call it. So the
  // work is queued for the worker to collect, exactly as extraction is.
  //
  // Until this existed the request fell through to a provider that always
  // refuses, and the student was told no AI was set up for their account,
  // which was never true.
  // `executionSite === 'none'` rather than `provider.name === 'null'`. Both
  // pick out the same object today, but one of them is a fact about what the
  // provider can do and the other is a string. It matters that this stays a
  // capability check: with mock AI switched on the resolver hands back a
  // MockProvider on this same path, and that one does run here, which is how
  // the end-to-end suite gets an explanation without a worker attached.
  /*
   * Tier C, which reads worksheets and does not write explanations yet.
   *
   * `executor === 'browser'` means the only thing that can run this student's
   * model is their own tab, and the browser runner does extraction alone
   * (app/(app)/worksheets/[id]/status/browser-runner.tsx). Falling through from
   * here reaches the null provider and answers "No AI is set up for your
   * account. Add an API key or connect Ollama in settings", to a student who
   * has connected Ollama and can watch it read their pages. Saying what is
   * actually true costs nothing and is the whole point of the tier reporting
   * its own state honestly.
   */
  if (executor === 'browser') {
    return NextResponse.json(
      {
        error:
          'Ollama reads your worksheets, but it does not write explanations yet. ' +
          'Add a cloud API key in settings if you want those.',
      },
      { status: 501 },
    )
  }

  if (executor === 'operator_gpu' && provider.executionSite === 'none') {
    const existing = await pendingExplainJob(db, userId, question.id)

    const jobId =
      existing ??
      (await enqueueJob(db, {
        worksheetId: question.worksheetId,
        userId,
        stage: 'explain',
        executor: 'operator_gpu',
        // Priority matters here in a way it does not for extraction: someone
        // is sat waiting on this, where an upload is left to run.
        priority: 'high',
        checkpoint: { questionId: question.id, attemptId: lastAttempt?.id ?? null },
      }))

    return NextResponse.json({ status: 'queued', jobId }, { status: 202 })
  }

  try {
    const result = await provider.explain({
      promptText: question.promptText,
      choices: choices.map((choice) => ({ label: choice.label, text: choice.text })),
      correctAnswer:
        choices.find((choice) => choice.isCorrect)?.label ?? question.correctAnswer,
      studentAnswer,
    })

    await db.insert(explanations).values({
      questionId: question.id,
      attemptId: lastAttempt?.id ?? null,
      bodyMd: result.body_md,
      misconceptionNote: result.misconception_note,
      // `storedProvider` returns null for the ones the column has no value
      // for, which is the mock and the null provider. The cast this replaces
      // asserted every provider was Anthropic.
      provider: storedProvider(provider.name),
      // The model, not the provider's name. This column read `anthropic` on
      // every row, which is what `provider` says two lines up.
      model: provider.model,
    })

    return NextResponse.json({
      explanation: { body: result.body_md, misconception: result.misconception_note },
      cached: false,
    })
  } catch (error) {
    if (error instanceof ProviderUnavailable) {
      return NextResponse.json(
        {
          error:
            'No AI is set up for your account. Add an API key or connect Ollama in settings.',
        },
        { status: 409 },
      )
    }

    if (error instanceof ProviderRefused) {
      return NextResponse.json(
        { error: 'The model declined to answer this one.' },
        { status: 422 },
      )
    }

    return NextResponse.json(
      { error: 'Could not generate an explanation. Try again.' },
      { status: 502 },
    )
  }
}
