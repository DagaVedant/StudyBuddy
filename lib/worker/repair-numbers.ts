import { asc, eq } from 'drizzle-orm'

import type { Db } from '@/lib/db/types'
import { questions, worksheetPages, worksheets } from '@/lib/db/schema'
import { inferPrintedNumbers } from '@/lib/questions/infer-numbers'

/**
 * Recovers printed numbers the model dropped or misread.
 *
 * Runs after the audit and the review, so it sees the final set of questions
 * rather than one the later stages are about to change. Its whole job is to
 * turn a question that is present but unlabelled into one the coverage check
 * can count, which is the difference between a worksheet reporting 112 of 114
 * and reporting the truth.
 */
export async function repairPrintedNumbers(
  db: Db,
  worksheetId: string,
): Promise<{ repaired: number }> {
  const [sheet] = await db
    .select({ expected: worksheets.expectedQuestionCount })
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  const rows = await db
    .select({
      id: questions.id,
      ordinal: questions.ordinal,
      printedNumber: questions.printedNumber,
      pageNumber: worksheetPages.pageNumber,
    })
    .from(questions)
    .leftJoin(worksheetPages, eq(worksheetPages.id, questions.pageId))
    .where(eq(questions.worksheetId, worksheetId))
    .orderBy(asc(questions.ordinal))

  if (rows.length === 0) return { repaired: 0 }

  const fixes = inferPrintedNumbers(
    rows.map((row) => ({
      id: row.id,
      pageNumber: row.pageNumber,
      position: row.ordinal,
      printedNumber: row.printedNumber,
    })),
    sheet?.expected ?? null,
  )

  for (const fix of fixes) {
    await db
      .update(questions)
      .set({ printedNumber: fix.to })
      .where(eq(questions.id, fix.id))

    console.log(
      `[numbers] ${fix.reason} on ${worksheetId}: ${fix.from ?? 'blank'} -> ${fix.to}`,
    )
  }

  return { repaired: fixes.length }
}
