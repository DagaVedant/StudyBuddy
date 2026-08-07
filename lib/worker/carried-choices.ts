import { createHash } from 'node:crypto'

import { asc, eq, inArray } from 'drizzle-orm'

import type { Db } from '@/lib/dashboard/queries'
import { answerChoices, questions, worksheetPages } from '@/lib/db/schema'
import { parseCarriedChoices } from '@/lib/questions/carried-choices'
import { sortWithinPage } from '@/lib/questions/page-order'
import { contentHashSource, normalizeForCompare } from '@/lib/questions/shape'
import { modalChoiceCount, validateQuestion } from '@/lib/questions/validate'

/**
 * Gives a question back the options the page break left on the next page.
 *
 * joinSplitQuestions handles a split the extractor noticed, where both halves
 * came back as rows. This handles the commoner one, where it noticed nothing:
 * a bare block of options with no question above it does not look like a
 * question, so the model returns nothing for it, and the stem at the foot of
 * the page before is stored with no answers and no trace that it had any. Four
 * of the five splits on the AMC8 2024 paper are this shape.
 *
 * The options are still there, in the next page's text layer, printed above
 * everything else on it. Reading them off the text needs no model and no
 * second pass over the image.
 *
 * Only ever adds. A question that already has options is never touched, and a
 * question that gets none is left exactly as damaged as it was, which the
 * student can see and fix.
 */

/** Types that could be hiding a lost option list. */
const RECOVERABLE = new Set(['multiple_choice', 'free_response'])

export async function recoverCarriedChoices(
  db: Db,
  worksheetId: string,
): Promise<{ recovered: number }> {
  const pages = await db
    .select({
      pageNumber: worksheetPages.pageNumber,
      ocrText: worksheetPages.ocrText,
    })
    .from(worksheetPages)
    .where(eq(worksheetPages.worksheetId, worksheetId))
    .orderBy(asc(worksheetPages.pageNumber))

  if (pages.length < 2) return { recovered: 0 }

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

  if (rows.length === 0) return { recovered: 0 }

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

  const candidates = rows.map((row) => ({
    ...row,
    top: Array.isArray(row.bbox) ? row.bbox[1] : null,
    position: row.ordinal,
    choices: byQuestion.get(row.id) ?? [],
  }))

  const expectedCount = modalChoiceCount(candidates)

  const byPage = new Map<number, typeof candidates>()
  for (const candidate of candidates) {
    if (candidate.pageNumber === null) continue
    byPage.set(candidate.pageNumber, [...(byPage.get(candidate.pageNumber) ?? []), candidate])
  }

  const fingerprint = (choices: { text: string }[]): string =>
    choices.map((choice) => normalizeForCompare(choice.text)).join('|')

  let recovered = 0

  for (const page of pages) {
    const carried = parseCarriedChoices(page.ocrText ?? '', { expectedCount })
    if (!carried) continue

    const previous = byPage.get(page.pageNumber - 1)
    if (!previous || previous.length === 0) continue

    const ordered = sortWithinPage(previous)
    const target = ordered[ordered.length - 1]

    // Only a question that is missing its options, and only one that could
    // have had any. A grid-in or a fill-in-the-blank is answer-free by design.
    if (target.choices.length > 0) continue
    if (!RECOVERABLE.has(target.questionType)) continue

    // Page furniture caught at the foot of a page is not a question waiting
    // for its answers.
    const codes = new Set(
      validateQuestion({
        printedNumber: target.printedNumber,
        promptText: target.promptText,
        questionType: target.questionType,
        choices: [],
      }).map((flag) => flag.code),
    )
    if (codes.has('stem_is_not_a_question') || codes.has('empty_stem')) continue

    // If the first question on this page already holds exactly these options,
    // the parse read that question's own answers rather than a carried block,
    // or the extractor already attached them to the wrong question. Either way
    // there is nothing here worth copying.
    const first = sortWithinPage(byPage.get(page.pageNumber) ?? [])[0]
    if (first && fingerprint(first.choices) === fingerprint(carried)) continue

    await db.insert(answerChoices).values(
      carried.map((choice) => ({
        questionId: target.id,
        label: choice.label,
        text: choice.text,
        isCorrect: false,
      })),
    )

    const contentHash = createHash('sha256')
      .update(contentHashSource(target.promptText, carried))
      .digest('hex')

    await db
      .update(questions)
      .set({
        contentHash,
        // The extractor calls a question with no options free-response, which
        // is a reasonable reading of what it could see. Now that the options
        // are back the type is wrong, and the review screen only offers
        // options on a question that claims to have them.
        questionType: 'multiple_choice',
      })
      .where(eq(questions.id, target.id))

    recovered += 1
    console.log(
      `[carried] question ${target.printedNumber ?? '?'} took ${carried.length} option(s) ` +
        `off page ${page.pageNumber} on ${worksheetId}`,
    )
  }

  return { recovered }
}
