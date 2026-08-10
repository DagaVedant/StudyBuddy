import { and, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { attempts, reviewCards, reviewLogs } from '@/lib/db/schema'
import { scheduleFromReview, type StoredCard } from '@/lib/review/fsrs'

const rateSchema = z.object({
  cardId: z.string().min(1),
  rating: z.enum(['again', 'hard', 'good', 'easy']),
})

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const parsed = rateSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const { cardId, rating } = parsed.data
  const userId = session.user.id

  const [card] = await db
    .select()
    .from(reviewCards)
    .where(and(eq(reviewCards.id, cardId), eq(reviewCards.userId, userId)))
    .limit(1)

  if (!card) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
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

  const { card: next, log } = scheduleFromReview(stored, rating)

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

  return NextResponse.json({ ok: true, dueAt: next.dueAt.toISOString() })
}
