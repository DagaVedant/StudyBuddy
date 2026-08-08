import { asc, eq, inArray } from 'drizzle-orm'

import { answerChoices, questions, worksheetPages } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'
import type { BBox } from '@/lib/db/schema'

export interface LoadedChoice {
  id: string
  label: string
  text: string
  isCorrect: boolean
}

export interface LoadedQuestion {
  id: string
  ordinal: number
  printedNumber: number | null
  promptText: string
  questionType: string
  bbox: BBox | null
  /** The top edge of the bbox: what puts a question in reading order. */
  top: number | null
  contentHash: string | null
  userVerified: boolean
  pageId: string | null
  pageNumber: number | null
  choices: LoadedChoice[]
}

/**
 * A worksheet's questions in paper order, each holding its own options.
 *
 * Six places wrote these same twenty lines: select the questions, select the
 * options with one `inArray`, group them into a Map. Then four of those
 * six went on to scan the flat option list with `.find()` once per row, which
 * is O(n·m) over 114 questions and their options.
 *
 * The column set is the union of what all six wanted, which costs a few extra
 * columns on the read and saves six divergent copies of the grouping.
 */
export async function loadQuestionsWithChoices(
  db: Db,
  worksheetId: string,
): Promise<LoadedQuestion[]> {
  const rows = await db
    .select({
      id: questions.id,
      ordinal: questions.ordinal,
      printedNumber: questions.printedNumber,
      promptText: questions.promptText,
      questionType: questions.questionType,
      bbox: questions.bbox,
      contentHash: questions.contentHash,
      userVerified: questions.userVerified,
      pageId: questions.pageId,
      pageNumber: worksheetPages.pageNumber,
    })
    .from(questions)
    .leftJoin(worksheetPages, eq(worksheetPages.id, questions.pageId))
    .where(eq(questions.worksheetId, worksheetId))
    .orderBy(asc(questions.ordinal))

  if (rows.length === 0) return []

  const choiceRows = await db
    .select({
      id: answerChoices.id,
      questionId: answerChoices.questionId,
      label: answerChoices.label,
      text: answerChoices.text,
      isCorrect: answerChoices.isCorrect,
    })
    .from(answerChoices)
    .where(
      inArray(
        answerChoices.questionId,
        rows.map((row) => row.id),
      ),
    )

  const choicesFor = new Map<string, LoadedChoice[]>()
  for (const choice of choiceRows) {
    const list = choicesFor.get(choice.questionId)
    const entry = {
      id: choice.id,
      label: choice.label,
      text: choice.text,
      isCorrect: choice.isCorrect,
    }
    if (list) list.push(entry)
    else choicesFor.set(choice.questionId, [entry])
  }

  return rows.map((row) => ({
    ...row,
    top: Array.isArray(row.bbox) ? row.bbox[1] : null,
    choices: choicesFor.get(row.id) ?? [],
  }))
}
