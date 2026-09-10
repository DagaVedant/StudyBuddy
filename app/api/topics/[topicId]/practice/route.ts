import {NextResponse} from 'next/server'
import {eq} from 'drizzle-orm'
import {z} from 'zod'
import {generatePractice, PRACTICE_BATCH, PRACTICE_BATCH_MAX} from '@/lib/practice'
import {ProviderRefused, ProviderUnavailable} from '@/lib/ai/types'
import {auth} from '@/auth'
import {db} from '@/lib/db'
import {guardRateLimit, PRACTICE_LIMIT, readJson} from '@/lib/api'
import {resolveProvider} from '@/lib/ai/resolve'
import {topics} from '@/lib/schema'

const bodySchema = z.object({
  count: z.number().int().min(1).max(PRACTICE_BATCH_MAX).optional(),
})

const NO_MODEL =
  'The model that writes these could not take this on right now. Try again shortly.'

const NOT_SET_UP =
  'Nothing is set up to write practice for this account. Connect your own AI provider in settings.'

const NOTHING_KEPT = 'Nothing came back that was good enough to practise on. Try again.'

async function postTopicidPractice(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const {topicId} = await params

  const session = await auth()
  if (!session || !session.user || !session.user.id) {
    return NextResponse.json({error: 'Unauthorized'}, {status: 401})
  }
  const userId = session.user.id

  let body = await readJson(request)
  if (body === null) body = {}

  const parsed = bodySchema.safeParse(body)
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

  if (executor !== 'server') {
    return NextResponse.json({error: NOT_SET_UP}, {status: 409})
  }

  if (provider.executionSite === 'none') {
    return NextResponse.json({error: NO_MODEL}, {status: 409})
  }

  const limited = await guardRateLimit(
    db,
    PRACTICE_LIMIT,
    'user:' + userId,
    'You have asked for a lot of practice today. Try again tomorrow.',
  )
  if (limited) return limited

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

export {postTopicidPractice as POST}
