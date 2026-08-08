import { eq } from 'drizzle-orm'

import { questions } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'
import {
  planDuplicateMerges,
  planNumberDuplicateMerges,
} from '@/lib/questions/duplicates-plan'
import { loadQuestionsWithChoices } from '@/lib/questions/load'
import { modalChoiceCount } from '@/lib/questions/validate'

/**
 * Folds a question the extractor emitted twice back into one row.
 *
 * Runs once the pages are all in and before the audit, so the audit sees a
 * repaired run: left alone, a phantom row both inflates the count and pushes
 * every following number up by one, which makes the audit hunt for a question
 * that was never missing.
 *
 * Safe at this point in the job because nothing downstream exists yet. The
 * student has not reached markup, so there are no attempts or review cards
 * pointing at these rows.
 */
export async function mergeDuplicateQuestions(
  db: Db,
  worksheetId: string,
): Promise<{ merged: number }> {
  const rows = await loadQuestionsWithChoices(db, worksheetId)

  if (rows.length < 2) return { merged: 0 }

  const candidates = rows.map((row) => ({
    id: row.id,
    printedNumber: row.printedNumber,
    promptText: row.promptText,
    choices: row.choices,
  }))

  const expectedChoices =
    modalChoiceCount(
      candidates.map((c) => ({
        printedNumber: c.printedNumber,
        promptText: c.promptText,
        questionType: 'multiple_choice',
        choices: c.choices,
      })),
    ) ?? 4

  // Two passes over different evidence. The first catches a question split in
  // two, which shares its text; the second catches one stored twice, which
  // shares its printed number but not its text.
  const plans = [
    ...planDuplicateMerges(candidates),
    ...planNumberDuplicateMerges(candidates, expectedChoices),
  ]

  for (const plan of plans) {
    // The surviving row takes the number the phantom was occupying, which
    // closes the gap the deletion would otherwise leave behind.
    if (plan.printedNumber !== null) {
      await db
        .update(questions)
        .set({ printedNumber: plan.printedNumber })
        .where(eq(questions.id, plan.keepId))
    }

    await db.delete(questions).where(eq(questions.id, plan.dropId))
  }

  return { merged: plans.length }
}
