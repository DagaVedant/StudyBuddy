import {NextResponse} from 'next/server'
import {auth} from '@/auth'
import {blooketDownload, getMissedQuestions} from '@/lib/blooket'
import {db} from '@/lib/db'
import {EXPORT_LIMIT, guardRateLimit} from '@/lib/api'

export async function GET() {
  const session = await auth()
  if (!session || !session.user || !session.user.id) {
    return new NextResponse('Unauthorized', {status: 401})
  }

  const limited = await guardRateLimit(
    db,
    EXPORT_LIMIT,
    'user:' + session.user.id,
    'Too many exports. Try again shortly.',
  )
  if (limited) return limited

  const missed = await getMissedQuestions(db, session.user.id)

  return blooketDownload(missed)
}
