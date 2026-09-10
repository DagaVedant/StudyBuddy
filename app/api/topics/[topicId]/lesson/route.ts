import {NextResponse} from 'next/server'
import {eq} from 'drizzle-orm'
import {generateLesson, getLesson, type StoredLesson} from '@/lib/practice'
import {ProviderRefused, ProviderUnavailable} from '@/lib/ai/types'
import {auth} from '@/auth'
import {db} from '@/lib/db'
import {guardRateLimit, LESSON_LIMIT} from '@/lib/api'
import {resolveProvider} from '@/lib/ai/resolve'
import {topics} from '@/lib/schema'

function serialize(lesson: StoredLesson) {
  return {
    bodyMd: lesson.bodyMd,
    examples: lesson.examples,
    commonErrors: lesson.commonErrors,
    model: lesson.model,
    generatedAt: lesson.generatedAt.toISOString(),
  }
}

async function postTopicidLesson(_request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const {topicId} = await params

  const session = await auth()
  if (!session || !session.user || !session.user.id) {
    return NextResponse.json({error: 'Unauthorized'}, {status: 401})
  }
  const userId = session.user.id

  const [topic] = await db
    .select({id: topics.id})
    .from(topics)
    .where(eq(topics.id, topicId))
    .limit(1)

  if (!topic) {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  const existing = await getLesson(db, topicId, userId)
  if (existing) {
    return NextResponse.json({lesson: serialize(existing)})
  }

  const limited = await guardRateLimit(
    db,
    LESSON_LIMIT,
    'user:' + userId,
    'You have asked for a lot of lessons. Try again shortly.',
  )
  if (limited) return limited

  const {provider, executor} = await resolveProvider(db, userId)

  if (executor !== 'server') {
    return NextResponse.json(
      {
        error:
          'Nothing is set up to write lessons for this account. Connect your own AI provider in settings.',
      },
      {status: 409},
    )
  }

  try {
    const generated = await generateLesson(db, provider, topicId)

    let lesson = generated
    if (!lesson) lesson = await getLesson(db, topicId, null)

    if (!lesson) {
      return NextResponse.json(
        {error: 'Could not generate that lesson. Try again.'},
        {status: 502},
      )
    }

    return NextResponse.json({lesson: serialize(lesson)})
  } catch (error) {
    if (error instanceof ProviderUnavailable) {
      return NextResponse.json(
        {error: 'The model that writes these could not take this on right now. Try again shortly.'},
        {status: 409},
      )
    }

    if (error instanceof ProviderRefused) {
      return NextResponse.json(
        {error: 'The model declined to write this lesson.'},
        {status: 422},
      )
    }

    return NextResponse.json(
      {error: 'Could not generate that lesson. Try again.'},
      {status: 502},
    )
  }
}

export {postTopicidLesson as POST}
