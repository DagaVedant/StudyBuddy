import { and, asc, eq, inArray, notExists, sql } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { answerChoices, questionSolutions, questions } from '@/lib/db/schema'
import { CHOICE_ORDER } from '@/lib/questions/sql'
import { authenticateWorker } from '@/lib/worker/auth'

type Params = { params: Promise<{ worksheetId: string }> }

export async function GET(request: Request, { params }: Params) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status })
  }

  const { worksheetId } = await params

  const rows = await db
    .select({
      id: questions.id,
      promptText: questions.promptText,
      printedNumber: questions.printedNumber,
      answerSource: questions.answerSource,
      pageId: questions.pageId,
    })
    .from(questions)
    .where(
      and(
        eq(questions.worksheetId, worksheetId),
        notExists(
          db
            .select({ one: sql`1` })
            .from(questionSolutions)
            .where(eq(questionSolutions.questionId, questions.id)),
        ),
      ),
    )
    .orderBy(asc(questions.ordinal), asc(questions.id))
    .limit(500)

  if (rows.length === 0) return NextResponse.json({ questions: [] })

  const choices = await db
    .select({
      questionId: answerChoices.questionId,
      label: answerChoices.label,
      text: answerChoices.text,
    })
    .from(answerChoices)
    .where(inArray(answerChoices.questionId, rows.map((row) => row.id)))
    .orderBy(...CHOICE_ORDER)

  const byQuestion = new Map<string, { label: string; text: string }[]>()
  for (const choice of choices) {
    const list = byQuestion.get(choice.questionId) ?? []
    list.push({ label: choice.label, text: choice.text })
    byQuestion.set(choice.questionId, list)
  }

  return NextResponse.json({
    questions: rows.map((row) => ({
      id: row.id,
      promptText: row.promptText,
      printedNumber: row.printedNumber,
      pageId: row.pageId,
      choices: byQuestion.get(row.id) ?? [],
    })),
  })
}
