import { asc, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { worksheetPages } from '@/lib/db/schema'
import { loadQuestionsWithChoices } from '@/lib/questions/load'
import { authenticateWorker } from '@/lib/worker/auth'

type Params = { params: Promise<{ worksheetId: string }> }

/**
 * The worksheet's questions as extracted, for the review pass.
 *
 * The coverage endpoint reports printed numbers only, which is all the audit
 * needs to find a gap. Judging whether a question came out *whole* needs its
 * text and options, so this returns them.
 */
export async function GET(request: Request, { params }: Params) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status })
  }

  const { worksheetId } = await params

  const pages = await db
    .select({ id: worksheetPages.id, pageNumber: worksheetPages.pageNumber })
    .from(worksheetPages)
    .where(eq(worksheetPages.worksheetId, worksheetId))
    .orderBy(asc(worksheetPages.pageNumber))

  const rows = await loadQuestionsWithChoices(db, worksheetId)

  if (rows.length === 0) return NextResponse.json({ questions: [] })

  const pageNumberFor = new Map(pages.map((page) => [page.id, page.pageNumber]))

  return NextResponse.json({
    questions: rows
      .filter((row) => row.pageId && pageNumberFor.has(row.pageId))
      .map((row) => ({
        id: row.id,
        pageNumber: pageNumberFor.get(row.pageId as string) as number,
        printedNumber: row.printedNumber,
        promptText: row.promptText,
        questionType: row.questionType,
        choices: row.choices.map((choice) => ({ label: choice.label, text: choice.text })),
      })),
  })
}
