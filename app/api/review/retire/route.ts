import { and, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { reviewCards } from '@/lib/db/schema'

const schema = z.object({ cardId: z.string().min(1) })

/**
 * "Got it": stop asking me this one.
 *
 * The card is stamped rather than deleted, and the attempts behind it are not
 * touched at all. That is the whole point of the feature: the question is still
 * one the student got wrong, so it still counts on the worksheet card, on the
 * topic page and in the Blooket export. All that changes is that the review
 * queue stops offering it.
 *
 * Deliberately not a rating. Rating it "easy" would push it a few months out
 * and it would come back, which is the behaviour a student is trying to escape
 * when they say they have this one.
 */
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

  // Scoped by owner in the update itself rather than read-then-write, so
  // somebody else's card id changes nothing and reports nothing back.
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
