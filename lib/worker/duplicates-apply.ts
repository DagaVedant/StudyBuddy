import { eq } from 'drizzle-orm'

import { questions } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'
import {
  planDuplicateMerges,
  planNumberDuplicateMerges,
} from '@/lib/questions/duplicates-plan'
import { loadQuestionsWithChoices } from '@/lib/questions/load'
import { modalChoiceCount } from '@/lib/questions/validate'
import { deletableQuestionIds } from '@/lib/worker/safe-delete'

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

  // A row the student has already answered is not a phantom to fold away, and
  // deleting it would take the attempt and the review card with it.
  const deletable = new Set(
    await deletableQuestionIds(
      db,
      plans.map((plan) => plan.dropId),
    ),
  )

  let merged = 0

  /*
   * Both plan lists were computed from one snapshot and then applied one by
   * one, so a number could be assigned twice.
   *
   * Each plan moves its printed number onto the row that survives. Two plans
   * built from the same read can name the same number: the split-merge sees a
   * question torn across a page break and wants number 7, and the
   * number-duplicate merge sees the same 7 held by two rows and wants it too.
   * Applied in order, the second overwrites the first, and the worksheet ends
   * with two rows both claiming 7, which is the exact state the audit then
   * tries to repair by deleting one of them.
   *
   * `planDuplicateMerges` hands the survivor `Math.min` of the pair's two
   * numbers with no view of the rest of the worksheet, so the number it picks
   * can belong to a third row neither plan ever mentions: a phantom at 5
   * merged into a real question at 9 sends the survivor to 5, and if some
   * unrelated row already legitimately carries 5, the worksheet now holds two
   * of them, which is exactly what this pass exists to prevent.
   *
   * So every row's number is tracked from the start, not only the numbers
   * plans hand out as they run. A plan's target number collides when anyone
   * other than the plan's own two rows currently holds it; the plan's own
   * phantom holding it is not a collision; that is the source of the number.
   */
  const holderOf = new Map<string, number>()
  const rowsWithNumber = new Map<number, Set<string>>()

  for (const candidate of candidates) {
    if (typeof candidate.printedNumber !== 'number') continue
    holderOf.set(candidate.id, candidate.printedNumber)
    const holders = rowsWithNumber.get(candidate.printedNumber) ?? new Set<string>()
    holders.add(candidate.id)
    rowsWithNumber.set(candidate.printedNumber, holders)
  }

  const gone = new Set<string>()

  for (const plan of plans) {
    // Two plans can also name the same row, once as the one to keep and once as
    // the one to drop. Whichever ran first already decided.
    if (gone.has(plan.dropId) || gone.has(plan.keepId)) {
      console.log(
        `[dedupe] skipped a plan on ${worksheetId}: an earlier merge already ` +
          `moved one of its rows`,
      )
      continue
    }

    if (!deletable.has(plan.dropId)) {
      console.log(
        `[dedupe] kept ${plan.dropId} on ${worksheetId}: a student has work against it`,
      )
      continue
    }

    if (plan.printedNumber !== null) {
      const holders = rowsWithNumber.get(plan.printedNumber) ?? new Set<string>()
      const others = [...holders].filter(
        (id) => id !== plan.keepId && id !== plan.dropId,
      )

      if (others.length > 0) {
        console.log(
          `[dedupe] kept ${plan.dropId} on ${worksheetId}: number ` +
            `${plan.printedNumber} is already held by another row on this worksheet`,
        )
        continue
      }
    }

    // The surviving row takes the number the phantom was occupying, which
    // closes the gap the deletion would otherwise leave behind.
    if (plan.printedNumber !== null) {
      await db
        .update(questions)
        .set({ printedNumber: plan.printedNumber })
        .where(eq(questions.id, plan.keepId))

      // Both rows' old numbers are freed and the survivor's new one is
      // claimed, so a later plan sees this merge's result rather than the
      // snapshot it was planned against.
      const keptOldNumber = holderOf.get(plan.keepId)
      if (typeof keptOldNumber === 'number') {
        rowsWithNumber.get(keptOldNumber)?.delete(plan.keepId)
      }
      const droppedOldNumber = holderOf.get(plan.dropId)
      if (typeof droppedOldNumber === 'number') {
        rowsWithNumber.get(droppedOldNumber)?.delete(plan.dropId)
      }

      const newHolders = rowsWithNumber.get(plan.printedNumber) ?? new Set<string>()
      newHolders.add(plan.keepId)
      rowsWithNumber.set(plan.printedNumber, newHolders)
      holderOf.set(plan.keepId, plan.printedNumber)
      holderOf.delete(plan.dropId)
    }

    await db.delete(questions).where(eq(questions.id, plan.dropId))
    gone.add(plan.dropId)
    merged += 1
  }

  return { merged }
}
