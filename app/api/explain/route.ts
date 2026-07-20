import { and, desc, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { consumeTrial } from '@/lib/ai/quota'
import { resolveProvider } from '@/lib/ai/resolve'
import { ProviderRefused, ProviderUnavailable } from '@/lib/ai/types'
import { auth } from '@/auth'
import type { Db } from '@/lib/dashboard/queries'
import { db } from '@/lib/db'
import { answerChoices, attempts, explanations, questions } from '@/lib/db/schema'

const schema = z.object({ questionId: z.string().min(1) })

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
  const client = db as unknown as Db

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

  const choices = await db
    .select()
    .from(answerChoices)
    .where(eq(answerChoices.questionId, question.id))

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

  const { provider, tier } = await resolveProvider(client, userId)

  if (tier === 'trial' && session.user.role !== 'admin') {
    const charge = await consumeTrial(client, userId, 'explanations', 1)
    if (!charge.ok) {
      return NextResponse.json({ error: charge.reason }, { status: 402 })
    }
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
      provider: provider.name === 'mock' ? null : (provider.name as 'anthropic'),
      model: provider.name,
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
