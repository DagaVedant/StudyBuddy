import {NextResponse} from 'next/server'
import {and, eq} from 'drizzle-orm'
import {z} from 'zod'
import {reviewCards} from '@/lib/schema'
import {auth} from '@/auth'
import {db} from '@/lib/db'
import {guardRateLimit, readJson, REVIEW_LIMIT} from '@/lib/api'

const schema = z.object({cardId: z.string().min(1)})

export async function POST(request: Request) {
  const session = await auth()
  if (!session || !session.user || !session.user.id) {
    return NextResponse.json({error: 'Unauthorized'}, {status: 401})
  }

  const parsed = schema.safeParse(await readJson(request))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const {cardId} = parsed.data

  const limited = await guardRateLimit(
    db,
    REVIEW_LIMIT,
    'user:' + session.user.id,
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
