import { and, asc, eq, ne } from 'drizzle-orm'

import { answerChoices, questions, worksheetPages } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'
import { mergeAnswerKeys, parseAnswerKey } from '@/lib/questions/answer-key'
import { normalizeChoiceLabel } from '@/lib/questions/shape'

/**
 * Writes the paper's own answer key onto its questions.
 *
 * Runs last, after the numbering passes, because it matches on the printed
 * number and that number is not final until they have finished with it.
 *
 * A key the student typed in themselves outranks anything read off the page and
 * is never touched. Everything else is replaced rather than merely filled,
 * because what the paper prints beats what a model inferred, and re-running the
 * job then lands on the same answer every time.
 */
export async function applyAnswerKey(
  db: Db,
  worksheetId: string,
): Promise<{ answered: number }> {
  const pages = await db
    .select({ ocrText: worksheetPages.ocrText })
    .from(worksheetPages)
    .where(eq(worksheetPages.worksheetId, worksheetId))
    .orderBy(asc(worksheetPages.pageNumber))

  const key = mergeAnswerKeys(pages.map((page) => parseAnswerKey(page.ocrText ?? '')))
  if (key.size === 0) return { answered: 0 }

  const rows = await db
    .select({
      id: questions.id,
      printedNumber: questions.printedNumber,
    })
    .from(questions)
    .where(
      and(
        eq(questions.worksheetId, worksheetId),
        // A key the student supplied is theirs, not the paper's, and is never
        // overwritten by this.
        ne(questions.answerSource, 'user_key'),
      ),
    )

  let answered = 0

  for (const row of rows) {
    if (row.printedNumber === null) continue

    const label = key.get(row.printedNumber)
    if (!label) continue

    await db
      .update(questions)
      .set({ correctAnswer: label, answerSource: 'pdf_key' })
      .where(eq(questions.id, row.id))

    // The option list is what the review screen ticks, so it has to agree with
    // the answer stored on the question. Written for every option rather than
    // only the winner, so a key that changed clears the previous tick.
    const choices = await db
      .select({
        id: answerChoices.id,
        label: answerChoices.label,
        isCorrect: answerChoices.isCorrect,
      })
      .from(answerChoices)
      .where(eq(answerChoices.questionId, row.id))

    for (const choice of choices) {
      const isCorrect = normalizeChoiceLabel(choice.label).toUpperCase() === label

      if (choice.isCorrect === isCorrect) continue
      await db
        .update(answerChoices)
        .set({ isCorrect })
        .where(eq(answerChoices.id, choice.id))
    }

    answered += 1
  }

  return { answered }
}
