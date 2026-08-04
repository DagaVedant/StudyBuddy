import { asc, eq, inArray } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { answerChoices, questions, worksheetPages } from '@/lib/db/schema'
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

  const rows = await db
    .select({
      id: questions.id,
      pageId: questions.pageId,
      printedNumber: questions.printedNumber,
      promptText: questions.promptText,
      questionType: questions.questionType,
    })
    .from(questions)
    .where(eq(questions.worksheetId, worksheetId))
    .orderBy(asc(questions.ordinal))

  if (rows.length === 0) return NextResponse.json({ questions: [] })

  const choiceRows = await db
    .select({
      questionId: answerChoices.questionId,
      label: answerChoices.label,
      text: answerChoices.text,
    })
    .from(answerChoices)
    .where(
      inArray(
        answerChoices.questionId,
        rows.map((row) => row.id),
      ),
    )

  const choicesFor = new Map<string, { label: string; text: string }[]>()
  for (const choice of choiceRows) {
    choicesFor.set(choice.questionId, [
      ...(choicesFor.get(choice.questionId) ?? []),
      { label: choice.label, text: choice.text },
    ])
  }

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
        choices: choicesFor.get(row.id) ?? [],
      })),
  })
}
