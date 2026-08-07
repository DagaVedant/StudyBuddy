import { createHash } from 'node:crypto'

import { asc, eq, inArray } from 'drizzle-orm'

import type { Db } from '@/lib/dashboard/queries'
import { answerChoices, questions, worksheetPages } from '@/lib/db/schema'
import { contentHashSource } from '@/lib/questions/shape'
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
  const rows = await db
    .select({
      id: questions.id,
      ordinal: questions.ordinal,
      printedNumber: questions.printedNumber,
      promptText: questions.promptText,
      questionType: questions.questionType,
      bbox: questions.bbox,
      pageNumber: worksheetPages.pageNumber,
    })
    .from(questions)
    .leftJoin(worksheetPages, eq(worksheetPages.id, questions.pageId))
    .where(eq(questions.worksheetId, worksheetId))
    .orderBy(asc(questions.ordinal))

  if (rows.length < 2) return { joined: 0 }

  const choiceRows = await db
    .select({
      questionId: answerChoices.questionId,
      label: answerChoices.label,
      text: answerChoices.text,
    })
    .from(answerChoices)
    .where(
      inArray(
        answerChoices.questionId,
        rows.map((row) => row.id),
      ),
    )

  const byQuestion = new Map<string, { label: string; text: string }[]>()
  for (const choice of choiceRows) {
    byQuestion.set(choice.questionId, [
      ...(byQuestion.get(choice.questionId) ?? []),
      { label: choice.label, text: choice.text },
    ])
  }

  const candidates: SplitHalf[] = rows.map((row) => ({
    id: row.id,
    pageNumber: row.pageNumber,
    position: row.ordinal,
    // bbox is [x0, y0, x1, y1]; the top edge is what puts a question in
    // reading order down the page.
    top: Array.isArray(row.bbox) ? row.bbox[1] : null,
    printedNumber: row.printedNumber,
    promptText: row.promptText,
    questionType: row.questionType,
    choices: byQuestion.get(row.id) ?? [],
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
    const contentHash = createHash('sha256')
      .update(contentHashSource(keep.promptText, drop.choices))
      .digest('hex')

    await db
      .update(questions)
      .set({ printedNumber: plan.printedNumber, contentHash })
      .where(eq(questions.id, plan.keepId))

    await db.delete(questions).where(eq(questions.id, plan.dropId))

    console.log(`[split] ${plan.reason} on ${worksheetId}`)
  }

  return { joined: plans.length }
}
