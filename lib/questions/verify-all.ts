import { and, eq, inArray, notInArray } from 'drizzle-orm'

import { questions } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'

/**
 * Marks every unchecked question on a worksheet verified, in one statement.
 *
 * The verify screen used to fire one PATCH per question behind this button,
 * which on the 114-question benchmark paper is 114 requests queued against a
 * five-connection pool, most of them still in flight when the student
 * navigates away.
 *
 * `notInArray` is only applied when there is something to exclude: with an
 * empty list it compiles to `id not in ()`, which is a syntax error rather
 * than a no-op.
 */
export async function verifyRemaining(
  db: Db,
  worksheetId: string,
  exclude: string[] = [],
): Promise<string[]> {
  const updated = await db
    .update(questions)
    .set({ userVerified: true })
    .where(
      and(
        eq(questions.worksheetId, worksheetId),
        eq(questions.userVerified, false),
        exclude.length > 0 ? notInArray(questions.id, exclude) : undefined,
      ),
    )
    .returning({ id: questions.id })

  return updated.map((row) => row.id)
}

/**
 * Undoes exactly what {@link verifyRemaining} just did.
 *
 * Verifying is not destructive the way deleting a question is — no row
 * disappears, only a boolean flips — so unlike question delete's undo, this
 * does not need to hold the write back for a window and splice locally. It
 * writes immediately, in one statement for the same reason the verify above
 * does: reverting 114 rows one PATCH at a time is the same pool-exhaustion
 * problem this exists to avoid, applied to the undo instead of the original
 * action.
 *
 * Takes exactly the ids to revert, not an exclusion list: undo has to target
 * the precise set that was just verified, which the caller already tracked.
 */
export async function unverifyQuestions(
  db: Db,
  worksheetId: string,
  ids: string[],
): Promise<string[]> {
  const updated = await db
    .update(questions)
    .set({ userVerified: false })
    .where(and(eq(questions.worksheetId, worksheetId), inArray(questions.id, ids)))
    .returning({ id: questions.id })

  return updated.map((row) => row.id)
}
