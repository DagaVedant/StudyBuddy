import {NextResponse} from 'next/server'
import {asc, eq} from 'drizzle-orm'
import {authenticateWorker} from '@/lib/worker/jobs'
import {questions, worksheetPages, worksheets} from '@/lib/schema'
import {countQuestionStarts, isAnswerPage} from '@/lib/questions/shape'
import {db} from '@/lib/db'

export async function GET(
  request: Request,
  {params}: {params: Promise<Record<string, string>>},
) {
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

    let list = byPage.get(row.pageId)

    if (!list) {
      list = []
      byPage.set(row.pageId, list)
    }

    list.push(row.printedNumber)
  }

  const coverage = []

  for (const page of pages) {
    let text = ''
    if (page.ocrText) text = page.ocrText

    let printed = byPage.get(page.id)
    if (!printed) printed = []

    coverage.push({
      pageNumber: page.pageNumber,
      printed: printed,
      expectsQuestions: countQuestionStarts(text) > 0 && !isAnswerPage(text),
    })
  }

  return NextResponse.json({pages: coverage})
}
