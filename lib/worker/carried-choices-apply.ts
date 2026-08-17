import { asc, eq } from 'drizzle-orm'

import { answerChoices, questions, worksheetPages } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'
import { parseCarriedChoices } from '@/lib/questions/carried-choices-plan'
import { loadQuestionsWithChoices } from '@/lib/questions/load'
import { sortWithinPage } from '@/lib/questions/page-text'
import {
  hashQuestion,
  normalizeChoiceLabel,
  normalizeForCompare,
} from '@/lib/questions/shape'
import { modalChoiceCount, validateQuestion } from '@/lib/questions/validate'

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

    
    
    if (!RECOVERABLE.has(target.questionType)) continue

    
    
    
    
    if (expectedCount === null ? target.choices.length > 0 : target.choices.length >= expectedCount) {
      continue
    }

    const held = target.choices.map((choice) => choice.label)

    const carried = parseCarriedChoices(page.ocrText ?? '', { expectedCount, held })
    if (!carried) continue

    
    
    const codes = new Set(
      validateQuestion({
        printedNumber: target.printedNumber,
        promptText: target.promptText,
        questionType: target.questionType,
        choices: target.choices,
      }).map((flag) => flag.code),
    )
    if (codes.has('stem_is_not_a_question') || codes.has('empty_stem')) continue

    
    
    
    
    const first = sortWithinPage(byPage.get(page.pageNumber) ?? [])[0]
    if (first && fingerprint(first.choices) === fingerprint(carried)) continue

    
    
    
    await db.insert(answerChoices).values(
      carried.map((choice) => ({
        questionId: target.id,
        label: normalizeChoiceLabel(choice.label),
        text: choice.text,
        isCorrect: false,
      })),
    )

    
    
    
    
    
    const whole = [...target.choices, ...carried].sort((a, b) =>
      a.label.localeCompare(b.label),
    )
    const contentHash = hashQuestion(target.promptText, whole)

    await db
      .update(questions)
      .set({
        contentHash,
        
        
        
        
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
