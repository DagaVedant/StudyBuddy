import { eq } from 'drizzle-orm'

import { answerChoices, questions } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'
import { loadQuestionsWithChoices } from '@/lib/questions/load'
import { hashQuestion } from '@/lib/questions/shape'
import { planPageSplitJoins, type SplitHalf } from '@/lib/questions/split-pages'
import { modalChoiceCount } from '@/lib/questions/validate'

/**
 * Rejoins a question the page break cut in two.
 *
 * Extraction sends one page at a time and the model never sees its neighbours,
 * so a stem printed at the foot of page N and the options printed at the head
 * of page N+1 arrive as two rows: a question with no answers, and a block of
 * answers under a caption that asks nothing. The student sees both, the count
 * is one too high, and neither row is usable on its own.
 *
 * Runs before repairPrintedNumbers and renumberQuestions, because joining
 * changes both the count and the order those two work from.
 *
 * Safe to delete a row here for the same reason the merge is: nothing
 * downstream exists yet, so no attempt or review card points at it. What makes
 * it safe to delete *this* row is planPageSplitJoins, which refuses every pair
 * it cannot account for.
 */
export async function joinSplitQuestions(
  db: Db,
  worksheetId: string,
): Promise<{ joined: number }> {
  const rows = await loadQuestionsWithChoices(db, worksheetId)

  if (rows.length < 2) return { joined: 0 }

  const candidates: SplitHalf[] = rows.map((row) => ({
    id: row.id,
    pageNumber: row.pageNumber,
    position: row.ordinal,
    top: row.top,
    printedNumber: row.printedNumber,
    promptText: row.promptText,
    questionType: row.questionType,
    choices: row.choices,
  }))

  const plans = planPageSplitJoins(candidates, {
    expectedChoiceCount: modalChoiceCount(candidates),
  })

  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]))

  for (const plan of plans) {
    const keep = byId.get(plan.keepId)
    const drop = byId.get(plan.dropId)
    if (!keep || !drop) continue

    // The options move rather than being copied and re-inserted, so nothing
    // that already points at them is disturbed and no ordering is invented.
    await db
      .update(answerChoices)
      .set({ questionId: plan.keepId })
      .where(eq(answerChoices.questionId, plan.dropId))

    // Rehashed because the row is no longer the content it was hashed from.
    // Left stale, the joined question would not match itself, and a later
    // re-read of either page would sail past the duplicate check and store a
    // second copy — the failure the review pass already caused once.
    const contentHash = hashQuestion(keep.promptText, drop.choices)

    await db
      .update(questions)
      .set({ printedNumber: plan.printedNumber, contentHash })
      .where(eq(questions.id, plan.keepId))

    await db.delete(questions).where(eq(questions.id, plan.dropId))

    console.log(`[split] ${plan.reason} on ${worksheetId}`)
  }

  return { joined: plans.length }
}
