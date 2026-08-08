import { asc, eq } from 'drizzle-orm'

import type { Db } from '@/lib/db/types'
import { questions, worksheetPages } from '@/lib/db/schema'
import { duplicatePrintedNumbers } from '@/lib/questions/duplicates-plan'

/**
 * Rewrites every question's ordinal from where it sits on the paper.
 *
 * Ordinals used to be handed out at insert time as one past the highest
 * already stored, which is two mistakes in one. It reads the maximum and then
 * writes, so two pages saved at the same moment both read the same number and
 * both take it. And even without that race it records arrival order, which
 * only matches the paper while pages arrive in order.
 *
 * Running it once at the end sidesteps both. Order comes from the page a
 * question is on and its printed number, so it is the same whatever sequence
 * the pages came back in, and duplicates and gaps are corrected on the way
 * through.
 *
 * Safe here because nothing downstream exists yet: the student has not reached
 * markup, so no attempt or review card points at these rows.
 *
 * It also reports any printed number claimed by more than one question. That is
 * not something to correct here, because this pass would happily give both rows
 * a clean consecutive ordinal and hide it: two questions printed as 14 is the
 * signature of a solutions page read as a second copy of the paper, and the
 * caller needs to see it rather than have it smoothed over.
 */
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
    // Page first. A question with no page lands at the end rather than the
    // front, where a missing value would otherwise sort.
    const pageA = a.pageNumber ?? Number.MAX_SAFE_INTEGER
    const pageB = b.pageNumber ?? Number.MAX_SAFE_INTEGER
    if (pageA !== pageB) return pageA - pageB

    // Then the number printed on the paper, which is the student's own order.
    const printedA = a.printedNumber ?? Number.MAX_SAFE_INTEGER
    const printedB = b.printedNumber ?? Number.MAX_SAFE_INTEGER
    if (printedA !== printedB) return printedA - printedB

    // Unnumbered questions on one page keep the order they were read in.
    return a.ordinal - b.ordinal
  })

  let renumbered = 0

  for (const [index, row] of ordered.entries()) {
    const next = index + 1
    if (row.ordinal === next) continue

    await db.update(questions).set({ ordinal: next }).where(eq(questions.id, row.id))
    renumbered += 1
  }

  return { renumbered, duplicateNumbers }
}
