import {NextResponse} from 'next/server'
import {asc, eq} from 'drizzle-orm'
import {authenticateWorker} from '@/lib/worker/jobs'
import {questions, worksheetPages, worksheets} from '@/lib/schema'
import {countQuestionStarts, isAnswerPage} from '@/lib/questions/shape'
import {db} from '@/lib/db'

async function getCoverageWorksheetid(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({error: auth.message}, {status: auth.status})
  }

  const {worksheetId} = await params

  const [worksheet] = await db
    .select({id: worksheets.id})
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  if (!worksheet) {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  const pages = await db
    .select({
      id: worksheetPages.id,
      pageNumber: worksheetPages.pageNumber,
      ocrText: worksheetPages.ocrText,
    })
    .from(worksheetPages)
    .where(eq(worksheetPages.worksheetId, worksheetId))
    .orderBy(asc(worksheetPages.pageNumber))

  const rows = await db
    .select({pageId: questions.pageId, printedNumber: questions.printedNumber})
    .from(questions)
    .where(eq(questions.worksheetId, worksheetId))

  const byPage = new Map<string, number[]>()
  for (const row of rows) {
    if (!row.pageId || row.printedNumber === null) continue
    const list = byPage.get(row.pageId) ?? []
    list.push(row.printedNumber)
    byPage.set(row.pageId, list)
  }

  return NextResponse.json({
    pages: pages.map((page) => {
      const text = page.ocrText ?? ''

      return {
        pageNumber: page.pageNumber,
        printed: byPage.get(page.id) ?? [],
        expectsQuestions: countQuestionStarts(text) > 0 && !isAnswerPage(text),
      }
    }),
  })
}

export {getCoverageWorksheetid as GET}
