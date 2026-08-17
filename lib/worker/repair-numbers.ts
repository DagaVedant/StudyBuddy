import { asc, eq } from 'drizzle-orm'

import type { Db } from '@/lib/db/types'
import { questions, worksheetPages, worksheets } from '@/lib/db/schema'
import { inferPrintedNumbers } from '@/lib/questions/numbering'

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
