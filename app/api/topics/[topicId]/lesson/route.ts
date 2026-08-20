import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { auth } from '@/auth'
import { ollamaConfig } from '@/lib/ai/ollama-config'
import { resolveProvider } from '@/lib/ai/resolve'
import { ProviderRefused, ProviderUnavailable, lessonSchema } from '@/lib/ai/types'
import { db } from '@/lib/db'
import { topics } from '@/lib/db/schema'
import { LESSON_LIMIT, guardRateLimit } from '@/lib/rate-limit'
import {
  generateLesson,
  getLesson,
  getOwnLesson,
  lessonInput,
  storeLesson,
  type StoredLesson,
} from '@/lib/topics'

type Params = { params: Promise<{ topicId: string }> }

function serialize(lesson: StoredLesson) {
  return {
    bodyMd: lesson.bodyMd,
    examples: lesson.examples,
    commonErrors: lesson.commonErrors,
    model: lesson.model,
    generatedAt: lesson.generatedAt.toISOString(),
  }
}

export async function POST(_request: Request, { params }: Params) {
  const { topicId } = await params

  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = session.user.id

  const [topic] = await db
    .select({ id: topics.id })
    .from(topics)
    .where(eq(topics.id, topicId))
    .limit(1)

  if (!topic) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const existing = await getLesson(db, topicId, userId)
  if (existing) {
    return NextResponse.json({ lesson: serialize(existing) })
  }

  const limited = await guardRateLimit(
    db,
    LESSON_LIMIT,
    `user:${userId}`,
    'You have asked for a lot of lessons. Try again shortly.',
  )
  if (limited) return limited

  const { provider, executor } = await resolveProvider(db, userId)

  if (executor === 'operator_gpu' && provider.executionSite === 'none') {
    return NextResponse.json(
      { error: 'Lesson generation needs a connected AI provider. Add one in Settings.' },
      { status: 409 },
    )
  }

  if (executor === 'browser') {
    const ollama = await ollamaConfig(db, userId)

    if (!ollama) {
      return NextResponse.json(
        { error: 'No Ollama is configured. Connect one in settings.' },
        { status: 409 },
      )
    }

    return NextResponse.json({
      runsHere: true,
      input: await lessonInput(db, topicId),
      ollama: { baseUrl: ollama.baseUrl, textModel: ollama.textModel },
    })
  }

  try {
    const generated = await generateLesson(db, provider, topicId)

    const lesson = generated ?? (await getLesson(db, topicId, null))
    if (!lesson) {
      return NextResponse.json(
        { error: 'Could not generate that lesson. Try again.' },
        { status: 502 },
      )
    }

    return NextResponse.json({ lesson: serialize(lesson) })
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
        { error: 'The model declined to write this lesson.' },
        { status: 422 },
      )
    }

    return NextResponse.json(
      { error: 'Could not generate that lesson. Try again.' },
      { status: 502 },
    )
  }
}

const storedSchema = z.object({
  lesson: lessonSchema,
  model: z.string().max(200).nullish(),
})

export async function PUT(request: Request, { params }: Params) {
  const { topicId } = await params

  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = session.user.id

  const [topic] = await db
    .select({ id: topics.id })
    .from(topics)
    .where(eq(topics.id, topicId))
    .limit(1)

  if (!topic) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const { executor } = await resolveProvider(db, userId)

  if (executor !== 'browser') {
    return NextResponse.json(
      { error: 'Lessons are written on the server for this account.' },
      { status: 409 },
    )
  }

  const parsed = storedSchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const existing = await getOwnLesson(db, topicId, userId)
  if (existing) {
    return NextResponse.json({ lesson: serialize(existing) })
  }

  const lesson = await storeLesson(
    db,
    topicId,
    userId,
    parsed.data.lesson,
    parsed.data.model ?? null,
  )

  return NextResponse.json({ lesson: serialize(lesson) })
}
