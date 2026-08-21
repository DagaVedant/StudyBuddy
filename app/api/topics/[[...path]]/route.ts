import {NextResponse} from 'next/server'
import {eq} from 'drizzle-orm'
import {z} from 'zod'

import {
  acceptPractice,
  generateLesson,
  generatePractice,
  getLesson,
  getOwnLesson,
  lessonInput,
  PRACTICE_BATCH,
  PRACTICE_BATCH_MAX,
  practiceInput,
  type StoredLesson,
  storeLesson,
} from '@/lib/practice'
import {
  generatedQuestionSchema,
  lessonSchema,
  ProviderRefused,
  ProviderUnavailable,
} from '@/lib/ai/types'
import {auth} from '@/auth'
import {db} from '@/lib/db'
import {endpoints, guardRateLimit, LESSON_LIMIT, PRACTICE_LIMIT} from '@/lib/api'
import {ollamaConfig} from '@/lib/ai/ollama'
import {resolveProvider} from '@/lib/ai/resolve'
import {topics} from '@/lib/db/schema'

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
  if (!session?.user?.id) {
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
    `user:${userId}`,
    'You have asked for a lot of lessons. Try again shortly.',
  )
  if (limited) return limited

  const {provider, executor} = await resolveProvider(db, userId)

  if (executor === 'operator_gpu' && provider.executionSite === 'none') {
    return NextResponse.json(
      {error: 'Lesson generation needs a connected AI provider. Add one in Settings.'},
      {status: 409},
    )
  }

  if (executor === 'browser') {
    const ollama = await ollamaConfig(db, userId)

    if (!ollama) {
      return NextResponse.json(
        {error: 'No Ollama is configured. Connect one in settings.'},
        {status: 409},
      )
    }

    return NextResponse.json({
      runsHere: true,
      input: await lessonInput(db, topicId),
      ollama: {baseUrl: ollama.baseUrl, textModel: ollama.textModel},
    })
  }

  try {
    const generated = await generateLesson(db, provider, topicId)

    const lesson = generated ?? (await getLesson(db, topicId, null))
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
        {
          error:
            'No AI is set up for your account. Add an API key or connect Ollama in settings.',
        },
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

const storedSchema = z.object({
  lesson: lessonSchema,
  model: z.string().max(200).nullish(),
})

async function putTopicidLesson(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const {topicId} = await params

  const session = await auth()
  if (!session?.user?.id) {
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

  const {executor} = await resolveProvider(db, userId)

  if (executor !== 'browser') {
    return NextResponse.json(
      {error: 'Lessons are written on the server for this account.'},
      {status: 409},
    )
  }

  const parsed = storedSchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const existing = await getOwnLesson(db, topicId, userId)
  if (existing) {
    return NextResponse.json({lesson: serialize(existing)})
  }

  const lesson = await storeLesson(
    db,
    topicId,
    userId,
    parsed.data.lesson,
    parsed.data.model ?? null,
  )

  return NextResponse.json({lesson: serialize(lesson)})
}

const bodySchema = z.object({
  count: z.number().int().min(1).max(PRACTICE_BATCH_MAX).optional(),
})

const NO_MODEL =
  'Writing practice questions needs a connected AI provider. Add an API key in Settings.'

const NO_OLLAMA = 'No Ollama is configured. Connect one in settings.'

const NOTHING_KEPT = 'Nothing came back that was good enough to practise on. Try again.'

async function postTopicidPractice(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const {topicId} = await params

  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({error: 'Unauthorized'}, {status: 401})
  }
  const userId = session.user.id

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const [topic] = await db
    .select({id: topics.id})
    .from(topics)
    .where(eq(topics.id, topicId))
    .limit(1)

  if (!topic) {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  const {provider, tier, executor} = await resolveProvider(db, userId)

  if (executor !== 'server' && executor !== 'browser') {
    return NextResponse.json({error: NO_MODEL}, {status: 409})
  }

  if (executor === 'server' && provider.executionSite === 'none') {
    return NextResponse.json({error: NO_MODEL}, {status: 409})
  }

  const limited = await guardRateLimit(
    db,
    PRACTICE_LIMIT,
    `user:${userId}`,
    'You have asked for a lot of practice today. Try again tomorrow.',
  )
  if (limited) return limited

  if (executor === 'browser') {
    const ollama = await ollamaConfig(db, userId)
    if (!ollama) {
      return NextResponse.json({error: NO_OLLAMA}, {status: 409})
    }

    return NextResponse.json({
      runsHere: true,
      input: await practiceInput(db, {
        userId,
        topicId,
        count: parsed.data.count ?? PRACTICE_BATCH,
      }),
      ollama: {baseUrl: ollama.baseUrl, textModel: ollama.textModel},
    })
  }

  try {
    const outcome = await generatePractice(db, provider, {
      userId,
      topicId,
      count: parsed.data.count ?? PRACTICE_BATCH,
      tier,
    })

    if (outcome.created === 0) {
      return NextResponse.json(
        {error: NOTHING_KEPT, rejected: outcome.rejected.length},
        {status: 422},
      )
    }

    return NextResponse.json({
      created: outcome.created,
      rejected: outcome.rejected.length,
    })
  } catch (error) {
    if (error instanceof ProviderUnavailable) {
      return NextResponse.json({error: NO_MODEL}, {status: 409})
    }

    if (error instanceof ProviderRefused) {
      return NextResponse.json(
        {error: 'The model declined to write practice for this topic.'},
        {status: 422},
      )
    }

    return NextResponse.json(
      {error: 'Could not write practice questions. Try again.'},
      {status: 502},
    )
  }
}

const writtenSchema = z.object({
  questions: z.array(generatedQuestionSchema).max(PRACTICE_BATCH_MAX),
  count: z.number().int().min(1).max(PRACTICE_BATCH_MAX).optional(),
  model: z.string().max(200).nullish(),
})

async function putTopicidPractice(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const {topicId} = await params

  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({error: 'Unauthorized'}, {status: 401})
  }
  const userId = session.user.id

  const parsed = writtenSchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const [topic] = await db
    .select({id: topics.id})
    .from(topics)
    .where(eq(topics.id, topicId))
    .limit(1)

  if (!topic) {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  const {tier, executor} = await resolveProvider(db, userId)

  if (executor !== 'browser') {
    return NextResponse.json(
      {error: 'Practice questions are written on the server for this account.'},
      {status: 409},
    )
  }

  const ollama = await ollamaConfig(db, userId)
  if (!ollama) {
    return NextResponse.json({error: NO_OLLAMA}, {status: 409})
  }

  const outcome = await acceptPractice(
    db,
    {name: 'ollama', answeringModel: parsed.data.model ?? ollama.textModel},
    {userId, topicId, count: parsed.data.count ?? PRACTICE_BATCH, tier},
    parsed.data.questions,
  )

  if (outcome.created === 0) {
    return NextResponse.json(
      {error: NOTHING_KEPT, rejected: outcome.rejected.length},
      {status: 422},
    )
  }

  return NextResponse.json({
    created: outcome.created,
    rejected: outcome.rejected.length,
  })
}

const handle = endpoints([
  ['POST', ':topicId/lesson', postTopicidLesson],
  ['PUT', ':topicId/lesson', putTopicidLesson],
  ['POST', ':topicId/practice', postTopicidPractice],
  ['PUT', ':topicId/practice', putTopicidPractice],
])

export const GET = handle
export const POST = handle
export const PATCH = handle
export const PUT = handle
export const DELETE = handle
