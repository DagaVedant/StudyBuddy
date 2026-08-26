import {NextResponse} from 'next/server'
import {eq} from 'drizzle-orm'
import {z} from 'zod'
import {generateLesson, getLesson, getOwnLesson, lessonInput, practiceWorksheetId, type StoredLesson, storeLesson} from '@/lib/practice'
import {enqueueJob, pendingTopicJob, workerStatus} from '@/lib/queue'
import {lessonSchema, ProviderRefused, ProviderUnavailable} from '@/lib/ai/types'
import {auth} from '@/auth'
import {db} from '@/lib/db'
import {guardRateLimit, LESSON_LIMIT} from '@/lib/api'
import {ollamaConfig} from '@/lib/ai/ollama'
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

  if (executor !== 'server' && executor !== 'browser') {
    const jobId =
      (await pendingTopicJob(db, userId, 'lesson', topicId)) ??
      (await enqueueJob(db, {
        worksheetId: await practiceWorksheetId(db, userId),
        userId,
        stage: 'lesson',
        executor: 'operator_gpu',
        priority: 'high',
        checkpoint: {topicId},
      }))

    return NextResponse.json(
      {status: 'queued', jobId, writerOnline: (await workerStatus(db)).online},
      {status: 202},
    )
  }

  if (executor === 'browser') {
    const ollama = await ollamaConfig(db, userId)

    if (!ollama) {
      return NextResponse.json(
        {error: 'Your own Ollama is not reachable, so this went to the GPU instead.'},
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
            'The GPU that writes these could not take this on right now. Try again shortly.',
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

const storedSchema = z.object({lesson: lessonSchema, model: z.string().max(200).nullish()})

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

export {postTopicidLesson as POST, putTopicidLesson as PUT}
