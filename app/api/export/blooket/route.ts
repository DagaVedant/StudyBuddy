import { NextResponse } from 'next/server'

import { auth } from '@/auth'
import { blooketDownload } from '@/lib/blooket'
import { getMissedQuestions } from '@/lib/blooket'
import { db } from '@/lib/db'
import { EXPORT_LIMIT, guardRateLimit } from '@/lib/rate-limit'

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  const limited = await guardRateLimit(
    db,
    EXPORT_LIMIT,
    `user:${session.user.id}`,
    'Too many exports. Try again shortly.',
  )
  if (limited) return limited

  return blooketDownload(await getMissedQuestions(db, session.user.id))
}
