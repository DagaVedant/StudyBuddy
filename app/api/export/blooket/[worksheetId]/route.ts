import {NextResponse} from 'next/server'
import {eq} from 'drizzle-orm'
import {blooketDownload, getMissedQuestions} from '@/lib/blooket'
import {db} from '@/lib/db'
import {EXPORT_LIMIT, guardRateLimit} from '@/lib/api'
import {guardWorksheet} from '@/lib/queue'
import {worksheets} from '@/lib/schema'

async function getBlooketWorksheetid(
  _request: Request,
  {params}: {params: Promise<Record<string, string>>},
) {
  const {worksheetId} = await params

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
    .select({title: worksheets.title})
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  const missed = await getMissedQuestions(db, guard.userId, {worksheetId})

  return blooketDownload(missed, worksheet?.title)
}

export {getBlooketWorksheetid as GET}
