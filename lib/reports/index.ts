import { and, desc, eq } from 'drizzle-orm'

import type { Db } from '@/lib/db/types'
import { explanations, questions, reports, worksheets } from '@/lib/db/schema'

export type ReportInput =
  | { kind: 'worksheet'; worksheetId: string; message?: string | null }
  | { kind: 'explanation'; questionId: string; message?: string | null }

export type ReportResult =
  | { ok: true; reportId: string }
  | { ok: false; reason: 'not_found' | 'nothing_to_report' }

/**
 * Records a student's report that something is wrong.
 *
 * Ownership is checked against the target rather than trusted from the input:
 * the id arrives from a browser, and without the check any signed-in account
 * could file reports against a stranger's worksheet and read its title back
 * off the admin page.
 *
 * An explanation report also sets `explanations.reported_wrong`, which is what
 * `/api/explain` reads to decide whether to hand back what it has or generate
 * again. That column existed and was read from the day it was added; this is
 * the write that was missing (finding 37).
 */
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

  // The newest explanation is the one on screen, and the only one worth
  // marking. Older rows for the same question are superseded already.
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
