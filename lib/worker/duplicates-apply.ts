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

  const plans = [
    ...planDuplicateMerges(candidates),
    ...planNumberDuplicateMerges(candidates, expectedChoices),
  ]

  const deletable = new Set(
    await deletableQuestionIds(
      db,
      plans.map((plan) => plan.dropId),
    ),
  )

  let merged = 0

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
