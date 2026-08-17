import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { blooketDownload } from '@/lib/blooket/download'
import { getMissedQuestions } from '@/lib/blooket/missed'
import { db } from '@/lib/db'
import { worksheets } from '@/lib/db/schema'
import { guardWorksheet } from '@/lib/upload/guard'

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

  const [worksheet] = await db
    .select({ title: worksheets.title })
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  const missed = await getMissedQuestions(db, guard.userId, { worksheetId })

  return blooketDownload(missed, worksheet?.title)
}
