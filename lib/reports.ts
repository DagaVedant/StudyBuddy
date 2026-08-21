import { and, desc, eq } from 'drizzle-orm'

import type { Db } from '@/lib/db'
import { explanations, questions, reports, worksheets } from '@/lib/db/schema'

export type ReportInput =
  | { kind: 'worksheet'; worksheetId: string; message?: string | null }
  | { kind: 'explanation'; questionId: string; message?: string | null }

export type ReportResult =
  | { ok: true; reportId: string }
  | { ok: false; reason: 'not_found' | 'nothing_to_report' }

export async function recordReport(
  db: Db,
  userId: string,
  input: ReportInput,
): Promise<ReportResult> {
  const message = input.message?.trim() || null

  if (input.kind === 'worksheet') {
    const [worksheet] = await db
      .select({ id: worksheets.id })
      .from(worksheets)
      .where(and(eq(worksheets.id, input.worksheetId), eq(worksheets.userId, userId)))
      .limit(1)

    if (!worksheet) return { ok: false, reason: 'not_found' }

    const [row] = await db
      .insert(reports)
      .values({ userId, kind: 'worksheet', worksheetId: worksheet.id, message })
      .returning({ id: reports.id })

    return { ok: true, reportId: row.id }
  }

  const [question] = await db
    .select({ id: questions.id, worksheetId: questions.worksheetId })
    .from(questions)
    .where(and(eq(questions.id, input.questionId), eq(questions.userId, userId)))
    .limit(1)

  if (!question) return { ok: false, reason: 'not_found' }

  const [explanation] = await db
    .select({ id: explanations.id })
    .from(explanations)
    .where(eq(explanations.questionId, question.id))
    .orderBy(desc(explanations.generatedAt))
    .limit(1)

  if (!explanation) return { ok: false, reason: 'nothing_to_report' }

  await db
    .update(explanations)
    .set({ reportedWrong: true })
    .where(eq(explanations.id, explanation.id))

  const [row] = await db
    .insert(reports)
    .values({
      userId,
      kind: 'explanation',
      worksheetId: question.worksheetId,
      questionId: question.id,
      explanationId: explanation.id,
      message,
    })
    .returning({ id: reports.id })

  return { ok: true, reportId: row.id }
}
