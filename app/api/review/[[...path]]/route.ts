import {NextResponse} from 'next/server'
import {and, eq} from 'drizzle-orm'
import {z} from 'zod'

import {attempts, reviewCards, reviewLogs} from '@/lib/db/schema'
import {auth} from '@/auth'
import {db} from '@/lib/db'
import {endpoints, guardRateLimit, REVIEW_LIMIT} from '@/lib/api'
import {scheduleFromReview, type StoredCard} from '@/lib/review'

const rateSchema = z.object({
  cardId: z.string().min(1),
  rating: z.enum(['again', 'hard', 'good', 'easy']),
})

async function postRate(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({error: 'Unauthorized'}, {status: 401})
  }

  const parsed = rateSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const {cardId, rating} = parsed.data
  const userId = session.user.id

  const limited = await guardRateLimit(
    db,
    REVIEW_LIMIT,
    `user:${userId}`,
    'That is a lot of reviewing in one hour. Take a break and come back.',
  )
  if (limited) return limited

  const [card] = await db
    .select()
    .from(reviewCards)
    .where(and(eq(reviewCards.id, cardId), eq(reviewCards.userId, userId)))
    .limit(1)

  if (!card) {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  const stored: StoredCard = {
    dueAt: card.dueAt,
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsedDays,
    scheduledDays: card.scheduledDays,
    learningSteps: card.learningSteps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    lastReview: card.lastReview,
  }

  const {card: next, log} = scheduleFromReview(stored, rating)

  await db.transaction(async (tx) => {
    await tx.update(reviewCards).set(next).where(eq(reviewCards.id, cardId))

    await tx.insert(reviewLogs).values({
      cardId,
      rating: log.rating,
      state: log.state,
      elapsedDays: log.elapsedDays,
      scheduledDays: log.scheduledDays,
    })

    await tx.insert(attempts).values({
      userId,
      questionId: card.questionId,
      outcome: rating === 'again' ? 'wrong' : rating === 'hard' ? 'unsure' : 'correct',
      source: 'review',
    })
  })

  return NextResponse.json({ok: true, dueAt: next.dueAt.toISOString()})
}
const schema = z.object({cardId: z.string().min(1)})

async function postRetire(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({error: 'Unauthorized'}, {status: 401})
  }

  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const {cardId} = parsed.data

  const limited = await guardRateLimit(
    db,
    REVIEW_LIMIT,
    `user:${session.user.id}`,
    'That is a lot of reviewing in one hour. Take a break and come back.',
  )
  if (limited) return limited

  const updated = await db
    .update(reviewCards)
    .set({retiredAt: new Date()})
    .where(and(eq(reviewCards.id, cardId), eq(reviewCards.userId, session.user.id)))
    .returning({id: reviewCards.id})

  if (updated.length === 0) {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  return NextResponse.json({ok: true})
}

const handle = endpoints([
  ['POST', 'rate', postRate],
  ['POST', 'retire', postRetire],
])

export const GET = handle
export const POST = handle
export const PATCH = handle
export const PUT = handle
export const DELETE = handle
