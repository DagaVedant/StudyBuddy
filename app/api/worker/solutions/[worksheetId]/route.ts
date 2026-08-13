import { and, asc, eq, inArray, notExists, sql } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { answerChoices, questionSolutions, questions } from '@/lib/db/schema'
import { CHOICE_ORDER } from '@/lib/questions/choice-order'
import { authenticateWorker } from '@/lib/worker/auth'

type Params = { params: Promise<{ worksheetId: string }> }

/**
 * The questions on this worksheet that still have no worked solution.
 *
 * The worker asks for work rather than being handed a list, which is what makes
 * a solving job resumable across a restart: whatever it has already posted back
 * is absent from the next answer, so a job that died at 80 of 114 asks for the
 * remaining 34 and not for all of them again.
 *
 * Everything is offered, including questions whose answer is already known from
 * the paper's own key. The working is the point for those: a student checking
 * their own paper wants the steps whether or not the answer was in doubt. What
 * the pipeline does with the derived answer afterwards is where the key is
 * protected, not here.
 */
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
      // For the retry: a question that turns on a graph or a net cannot be
      // answered from its text, and the page it is printed on is the only
      // place that information exists.
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
    // `inArray`, not an interpolated list. These ids come from our own table
    // and are safe today, which is exactly the reasoning that leaves a real
    // injection behind the day the source changes.
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
