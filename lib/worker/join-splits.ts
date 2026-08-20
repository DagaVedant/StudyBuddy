import { eq } from 'drizzle-orm'

import { answerChoices, questions } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'
import { loadQuestionsWithChoices } from '@/lib/questions/load'
import { hashQuestion } from '@/lib/questions/shape'
import { planPageSplitJoins, type SplitHalf } from '@/lib/questions/split-pages'
import { modalChoiceCount } from '@/lib/questions/validate'
import { deletableQuestionIds } from '@/lib/worker/safe-delete'

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

  const deletable = new Set(
    await deletableQuestionIds(
      db,
      plans.map((plan) => plan.dropId),
    ),
  )

  let joined = 0

  for (const plan of plans) {
    const keep = byId.get(plan.keepId)
    const drop = byId.get(plan.dropId)
    if (!keep || !drop) continue

    if (!deletable.has(plan.dropId)) {
      console.log(
        `[split] left ${plan.dropId} on ${worksheetId}: a student has work against it`,
      )
      continue
    }

    await db
      .update(answerChoices)
      .set({ questionId: plan.keepId })
      .where(eq(answerChoices.questionId, plan.dropId))

    const contentHash = hashQuestion(keep.promptText, drop.choices)

    await db
      .update(questions)
      .set({ printedNumber: plan.printedNumber, contentHash })
      .where(eq(questions.id, plan.keepId))

    await db.delete(questions).where(eq(questions.id, plan.dropId))
    joined += 1

    console.log(`[split] ${plan.reason} on ${worksheetId}`)
  }

  return { joined }
}
