import { asc, eq, sql } from 'drizzle-orm'

import type { Db } from '@/lib/db/types'
import { questions, worksheetPages } from '@/lib/db/schema'
import { duplicatePrintedNumbers } from '@/lib/questions/duplicates-plan'

export async function renumberQuestions(
  db: Db,
  worksheetId: string,
): Promise<{ renumbered: number; duplicateNumbers: number[] }> {
  const rows = await db
    .select({
      id: questions.id,
      ordinal: questions.ordinal,
      pageNumber: worksheetPages.pageNumber,
      printedNumber: questions.printedNumber,
    })
    .from(questions)
    .leftJoin(worksheetPages, eq(worksheetPages.id, questions.pageId))
    .where(eq(questions.worksheetId, worksheetId))
    .orderBy(asc(questions.ordinal))

  if (rows.length === 0) return { renumbered: 0, duplicateNumbers: [] }

  const duplicateNumbers = duplicatePrintedNumbers(rows)

  const ordered = [...rows].sort((a, b) => {
    const pageA = a.pageNumber ?? Number.MAX_SAFE_INTEGER
    const pageB = b.pageNumber ?? Number.MAX_SAFE_INTEGER
    if (pageA !== pageB) return pageA - pageB

    const printedA = a.printedNumber ?? Number.MAX_SAFE_INTEGER
    const printedB = b.printedNumber ?? Number.MAX_SAFE_INTEGER
    if (printedA !== printedB) return printedA - printedB

    return a.ordinal - b.ordinal
  })

  const moved = ordered
    .map((row, index) => ({ id: row.id, ordinal: index + 1 }))
    .filter((row, index) => ordered[index].ordinal !== row.ordinal)

  if (moved.length > 0) {
    const values = sql.join(
      moved.map((row) => sql`(${row.id}, ${row.ordinal}::int)`),
      sql`, `,
    )

    await db.execute(sql`
      update ${questions} as q
      set ordinal = v.ordinal
      from (values ${values}) as v(id, ordinal)
      where q.id = v.id
    `)
  }

  const renumbered = moved.length

  return { renumbered, duplicateNumbers }
}
