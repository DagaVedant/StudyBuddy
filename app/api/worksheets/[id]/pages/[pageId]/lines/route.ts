import {NextResponse} from 'next/server'
import {and, eq} from 'drizzle-orm'
import {worksheetPages} from '@/lib/schema'
import {guardWorksheet} from '@/lib/queue'
import {db} from '@/lib/db'
import {roundLines} from '@/lib/questions/shape'

async function getIdPagesPageidLines(_request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const {id: worksheetId, pageId} = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({error: 'Not found'}, {status: guard.status})
  }

  const [row] = await db
    .select({textLines: worksheetPages.textLines})
    .from(worksheetPages)
    .where(and(eq(worksheetPages.id, pageId), eq(worksheetPages.worksheetId, worksheetId)))
    .limit(1)

  if (!row) {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  return NextResponse.json({textLines: roundLines(row.textLines)})
}

export {getIdPagesPageidLines as GET}
