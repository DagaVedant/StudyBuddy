import { asc, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { questions, worksheetPages, worksheets } from '@/lib/db/schema'
import { isAnswerPage } from '@/lib/questions/answer-key'
import { countQuestionStarts } from '@/lib/questions/page-text'
import { authenticateWorker } from '@/lib/worker/auth'

type Params = { params: Promise<{ worksheetId: string }> }

export async function GET(request: Request, { params }: Params) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status })
  }

  const { worksheetId } = await params

  const [worksheet] = await db
    .select({ id: worksheets.id })
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  if (!worksheet) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
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
    .select({ pageId: questions.pageId, printedNumber: questions.printedNumber })
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
