import {NextResponse} from 'next/server'
import {eq} from 'drizzle-orm'
import {z} from 'zod'
import {acceptPractice, generatePractice, PRACTICE_BATCH, PRACTICE_BATCH_MAX, practiceInput, practiceWorksheetId} from '@/lib/practice'
import {enqueueJob, pendingTopicJob, workerStatus} from '@/lib/queue'
import {generatedQuestionSchema, ProviderRefused, ProviderUnavailable} from '@/lib/ai/types'
import {auth} from '@/auth'
import {db} from '@/lib/db'
import {guardRateLimit, PRACTICE_LIMIT, readJson} from '@/lib/api'
import {ollamaConfig} from '@/lib/ai/ollama'
import {resolveProvider} from '@/lib/ai/resolve'
import {topics} from '@/lib/schema'

const bodySchema = z.object({
  count: z.number().int().min(1).max(PRACTICE_BATCH_MAX).optional(),
})

const NO_MODEL =
  'The GPU that writes these could not take this on right now. Try again shortly.'

const NO_OLLAMA = 'Your own Ollama is not reachable, so this went to the GPU instead.'

const NOTHING_KEPT = 'Nothing came back that was good enough to practise on. Try again.'

async function postTopicidPractice(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const {topicId} = await params

  const session = await auth()
  if (!session || !session.user || !session.user.id) {
    return NextResponse.json({error: 'Unauthorized'}, {status: 401})
  }
  const userId = session.user.id

  const parsed = bodySchema.safeParse(await readJson(request))
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

  const resolved = await resolveProvider(db, userId)
  const provider = resolved.provider
  const tier = resolved.tier
  const executor = resolved.executor

  let wanted = PRACTICE_BATCH
  if (parsed.data.count) wanted = parsed.data.count

  if (executor !== 'server' && executor !== 'browser') {
    let jobId = await pendingTopicJob(db, userId, 'practice', topicId)

    if (!jobId) {
      jobId = await enqueueJob(db, {
        worksheetId: await practiceWorksheetId(db, userId),
        userId,
        stage: 'practice',
        executor: 'operator_gpu',
        priority: 'high',
        checkpoint: {topicId, count: wanted},
      })
    }

    const worker = await workerStatus(db)

    return NextResponse.json(
      {status: 'queued', jobId, writerOnline: worker.online},
      {status: 202},
    )
  }

  if (executor === 'server' && provider.executionSite === 'none') {
    return NextResponse.json({error: NO_MODEL}, {status: 409})
  }

  const limited = await guardRateLimit(
    db,
    PRACTICE_LIMIT,
    'user:' + userId,
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
        count: wanted,
      }),
      ollama: {baseUrl: ollama.baseUrl, textModel: ollama.textModel},
    })
  }

  try {
    const outcome = await generatePractice(db, provider, {
      userId,
      topicId,
      count: wanted,
      tier,
    })

    if (outcome.created === 0) {
      return NextResponse.json(
        {error: NOTHING_KEPT, rejected: outcome.rejected.length},
        {status: 422},
      )
    }

    return NextResponse.json({created: outcome.created, rejected: outcome.rejected.length})
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
  if (!session || !session.user || !session.user.id) {
    return NextResponse.json({error: 'Unauthorized'}, {status: 401})
  }
  const userId = session.user.id

  const parsed = writtenSchema.safeParse(await readJson(request))
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

  const resolved = await resolveProvider(db, userId)
  const tier = resolved.tier
  const executor = resolved.executor

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

  let wanted = PRACTICE_BATCH
  if (parsed.data.count) wanted = parsed.data.count

  let answeringModel = ollama.textModel
  if (parsed.data.model) answeringModel = parsed.data.model

  const outcome = await acceptPractice(
    db,
    {name: 'ollama', answeringModel: answeringModel},
    {userId, topicId, count: wanted, tier},
    parsed.data.questions,
  )

  if (outcome.created === 0) {
    return NextResponse.json(
      {error: NOTHING_KEPT, rejected: outcome.rejected.length},
      {status: 422},
    )
  }

  return NextResponse.json({created: outcome.created, rejected: outcome.rejected.length})
}

export {postTopicidPractice as POST, putTopicidPractice as PUT}
