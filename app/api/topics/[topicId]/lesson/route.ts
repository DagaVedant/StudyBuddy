import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { auth } from '@/auth'
import { resolveProvider } from '@/lib/ai/resolve'
import { ProviderRefused, ProviderUnavailable } from '@/lib/ai/types'
import { db } from '@/lib/db'
import { topics } from '@/lib/db/schema'
import { generateLesson, getLesson, type StoredLesson } from '@/lib/topics/lesson'

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

  const existing = await getLesson(db, topicId)
  if (existing) {
    return NextResponse.json({ lesson: serialize(existing) })
  }

  const { provider, executor } = await resolveProvider(db, userId)

  if (executor === 'operator_gpu' && provider.executionSite === 'none') {
    return NextResponse.json(
      { error: 'Lesson generation needs a connected AI provider. Add one in Settings.' },
      { status: 409 },
    )
  }

  if (executor === 'browser') {
    return NextResponse.json(
      {
        error:
          'Ollama reads your worksheets, but it does not write lessons yet. ' +
          'Add a cloud API key in settings if you want those.',
      },
      { status: 501 },
    )
  }

  try {
    const generated = await generateLesson(db, provider, topicId)

    const lesson = generated ?? (await getLesson(db, topicId))
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
