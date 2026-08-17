import { and, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { reviewCards } from '@/lib/db/schema'
import { REVIEW_LIMIT, guardRateLimit } from '@/lib/rate-limit'

const schema = z.object({ cardId: z.string().min(1) })

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const { cardId } = parsed.data

  const limited = await guardRateLimit(
    db,
    REVIEW_LIMIT,
    `user:${session.user.id}`,
    'That is a lot of reviewing in one hour. Take a break and come back.',
  )
  if (limited) return limited

  const updated = await db
    .update(reviewCards)
    .set({ retiredAt: new Date() })
    .where(and(eq(reviewCards.id, cardId), eq(reviewCards.userId, session.user.id)))
    .returning({ id: reviewCards.id })

  if (updated.length === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  return NextResponse.json({ ok: true })
}
