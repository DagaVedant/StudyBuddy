import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { blooketDownload } from '@/lib/blooket'
import { getMissedQuestions } from '@/lib/blooket'
import { db } from '@/lib/db'
import { worksheets } from '@/lib/db/schema'
import { EXPORT_LIMIT, guardRateLimit } from '@/lib/rate-limit'
import { guardWorksheet } from '@/lib/queue'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ worksheetId: string }> },
) {
  const { worksheetId } = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return new NextResponse(guard.status === 401 ? 'Unauthorized' : 'Not found', {
      status: guard.status,
    })
  }

  const limited = await guardRateLimit(
    db,
    EXPORT_LIMIT,
    `user:${guard.userId}`,
    'Too many exports. Try again shortly.',
  )
  if (limited) return limited

  const [worksheet] = await db
    .select({ title: worksheets.title })
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  const missed = await getMissedQuestions(db, guard.userId, { worksheetId })

  return blooketDownload(missed, worksheet?.title)
}
