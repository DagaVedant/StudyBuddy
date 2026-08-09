import { asc, eq } from 'drizzle-orm'

import { answerChoices, questions, worksheetPages } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'
import { parseCarriedChoices } from '@/lib/questions/carried-choices-plan'
import { loadQuestionsWithChoices } from '@/lib/questions/load'
import { sortWithinPage } from '@/lib/questions/page-order'
import {
  hashQuestion,
  normalizeChoiceLabel,
  normalizeForCompare,
} from '@/lib/questions/shape'
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

  const rows = await loadQuestionsWithChoices(db, worksheetId)

  if (rows.length === 0) return { recovered: 0 }

  const candidates = rows.map((row) => ({ ...row, position: row.ordinal }))

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
    const previous = byPage.get(page.pageNumber - 1)
    if (!previous || previous.length === 0) continue

    const ordered = sortWithinPage(previous)
    const target = ordered[ordered.length - 1]

    // Only a question that could have had options at all. A grid-in or a
    // fill-in-the-blank is answer-free by design.
    if (!RECOVERABLE.has(target.questionType)) continue

    // A question with its full set is finished. One with some of them is the
    // commoner shape and the one this pass used to walk past: the break falls
    // inside the option list, the stem keeps A, and B, C and D are printed at
    // the top of the next page. What it kept says where the rest begins.
    if (expectedCount === null ? target.choices.length > 0 : target.choices.length >= expectedCount) {
      continue
    }

    const held = target.choices.map((choice) => choice.label)

    const carried = parseCarriedChoices(page.ocrText ?? '', { expectedCount, held })
    if (!carried) continue

    // Page furniture caught at the foot of a page is not a question waiting
    // for its answers.
    const codes = new Set(
      validateQuestion({
        printedNumber: target.printedNumber,
        promptText: target.promptText,
        questionType: target.questionType,
        choices: target.choices,
      }).map((flag) => flag.code),
    )
    if (codes.has('stem_is_not_a_question') || codes.has('empty_stem')) continue

    // If the first question on this page already holds exactly these options,
    // the parse read that question's own answers rather than a carried block,
    // or the extractor already attached them to the wrong question. Either way
    // there is nothing here worth copying.
    const first = sortWithinPage(byPage.get(page.pageNumber) ?? [])[0]
    if (first && fingerprint(first.choices) === fingerprint(carried)) continue

    // Normalised even though the parser only ever produces a single letter, so
    // that every row reaching this table has been through the same function
    // rather than relying on each writer to be careful.
    await db.insert(answerChoices).values(
      carried.map((choice) => ({
        questionId: target.id,
        label: normalizeChoiceLabel(choice.label),
        text: choice.text,
        isCorrect: false,
      })),
    )

    // Hashed over what the question holds now, kept options included, so a row
    // that recovered a tail still matches itself on the next pass. Sorted by
    // label rather than left in the order the rows came back in, because the
    // options are loaded unordered and the hash is position-sensitive: an
    // A, B, C, D question has to hash the same here as it does at ingest.
    const whole = [...target.choices, ...carried].sort((a, b) =>
      a.label.localeCompare(b.label),
    )
    const contentHash = hashQuestion(target.promptText, whole)

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
