import { inArray } from 'drizzle-orm'

import { attempts, reviewCards } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'

/**
 * Of these questions, the ones nothing downstream is holding.
 *
 * The repair passes delete rows, and each carries a note saying that is safe
 * because the student has not reached markup yet, so no attempt or review card
 * points at them. That is true of a clean first run and false of every re-run,
 * and nothing enforced it: `questions` cascades to both `attempts` and
 * `review_cards`, so a merge landing after a student had marked the worksheet
 * took their answers and their whole revision schedule with it, with no error
 * and nothing in the log to notice afterwards.
 *
 * So it is checked rather than assumed. The two failures are not comparable: a
 * duplicate question left in place is visible on the review screen and the
 * student can delete it, and a silently deleted attempt is gone.
 *
 * Both tables are read by `question_id`, which wants an index on each to stay
 * cheap (FIXES.md B-8).
 */
export async function deletableQuestionIds(db: Db, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return []

  const [claimedByAttempt, claimedByCard] = await Promise.all([
    db
      .select({ id: attempts.questionId })
      .from(attempts)
      .where(inArray(attempts.questionId, ids)),
    db
      .select({ id: reviewCards.questionId })
      .from(reviewCards)
      .where(inArray(reviewCards.questionId, ids)),
  ])

  const claimed = new Set([
    ...claimedByAttempt.map((row) => row.id),
    ...claimedByCard.map((row) => row.id),
  ])

  return ids.filter((id) => !claimed.has(id))
}
