import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { auth } from '@/auth'
import { resolveProvider } from '@/lib/ai/resolve'
import { ProviderRefused, ProviderUnavailable } from '@/lib/ai/types'
import { db } from '@/lib/db'
import { topics } from '@/lib/db/schema'
import {
  PRACTICE_BATCH,
  PRACTICE_BATCH_MAX,
  generatePractice,
} from '@/lib/practice/generate'
import { PRACTICE_LIMIT, guardRateLimit } from '@/lib/rate-limit'

type Params = { params: Promise<{ topicId: string }> }

const bodySchema = z.object({
  count: z.number().int().min(1).max(PRACTICE_BATCH_MAX).optional(),
})

const NO_MODEL =
  'Writing practice questions needs a connected AI provider. Add an API key in Settings.'

const NOT_ON_OLLAMA =
  'Ollama reads your worksheets, but it does not write practice questions yet. ' +
  'Add a cloud API key in settings if you want those.'

export async function POST(request: Request, { params }: Params) {
  const { topicId } = await params

  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = session.user.id

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const [topic] = await db
    .select({ id: topics.id })
    .from(topics)
    .where(eq(topics.id, topicId))
    .limit(1)

  if (!topic) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const { provider, tier, executor } = await resolveProvider(db, userId)

  if (executor === 'browser') {
    return NextResponse.json({ error: NOT_ON_OLLAMA }, { status: 501 })
  }

  if (executor !== 'server' || provider.executionSite === 'none') {
    return NextResponse.json({ error: NO_MODEL }, { status: 409 })
  }

  const limited = await guardRateLimit(
    db,
    PRACTICE_LIMIT,
    `user:${userId}`,
    'You have asked for a lot of practice today. Try again tomorrow.',
  )
  if (limited) return limited

  try {
    const outcome = await generatePractice(db, provider, {
      userId,
      topicId,
      count: parsed.data.count ?? PRACTICE_BATCH,
      tier,
    })

    if (outcome.created === 0) {
      return NextResponse.json(
        {
          error:
            'Nothing came back that was good enough to practise on. Try again.',
          rejected: outcome.rejected.length,
        },
        { status: 422 },
      )
    }

    return NextResponse.json({
      created: outcome.created,
      rejected: outcome.rejected.length,
    })
  } catch (error) {
    if (error instanceof ProviderUnavailable) {
      return NextResponse.json({ error: NO_MODEL }, { status: 409 })
    }

    if (error instanceof ProviderRefused) {
      return NextResponse.json(
        { error: 'The model declined to write practice for this topic.' },
        { status: 422 },
      )
    }

    return NextResponse.json(
      { error: 'Could not write practice questions. Try again.' },
      { status: 502 },
    )
  }
}
