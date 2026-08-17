import { and, asc, eq, inArray, sql } from 'drizzle-orm'

import { answerChoices, attempts, questions, worksheets } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'
import { CHOICE_ORDER } from '@/lib/questions/sql'

import type { ExportQuestion } from './csv'

export const EXPORT_LIMIT = 1000

function everMissed(userId: string) {
  return sql`exists (
    select 1 from ${attempts}
    where ${attempts.questionId} = ${questions.id}
      and ${attempts.userId} = ${userId}
      and ${attempts.outcome} in ('wrong', 'unsure')
  )`
}

function missedBy(userId: string, worksheetId?: string) {
  return and(
    eq(questions.userId, userId),
    eq(questions.origin, 'extracted'),
    worksheetId ? eq(questions.worksheetId, worksheetId) : undefined,
    everMissed(userId),
  )
}

export interface MissedFilter {
  worksheetId?: string
  limit?: number
}

export async function getMissedQuestions(
  db: Db,
  userId: string,
  { worksheetId, limit = EXPORT_LIMIT }: MissedFilter = {},
): Promise<ExportQuestion[]> {
  const rows = await db
    .select({
      id: questions.id,
      promptText: questions.promptText,
      questionType: questions.questionType,
      correctAnswer: questions.correctAnswer,
    })
    .from(questions)
    .innerJoin(worksheets, eq(worksheets.id, questions.worksheetId))
    .where(missedBy(userId, worksheetId))
    .orderBy(asc(worksheets.createdAt), asc(questions.ordinal))
    .limit(limit)

  if (rows.length === 0) return []

  const choices = await db
    .select({
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
    .orderBy(...CHOICE_ORDER)

  const choicesFor = new Map<string, ExportQuestion['choices']>()
  for (const choice of choices) {
    const list = choicesFor.get(choice.questionId)
    const entry = { label: choice.label, text: choice.text, isCorrect: choice.isCorrect }
    if (list) list.push(entry)
    else choicesFor.set(choice.questionId, [entry])
  }

  return rows.map((row) => ({
    id: row.id,
    promptText: row.promptText,
    questionType: row.questionType,
    correctAnswer: row.correctAnswer,
    choices: choicesFor.get(row.id) ?? [],
  }))
}

export async function countMissedQuestions(
  db: Db,
  userId: string,
  worksheetId?: string,
): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(questions)
    .where(missedBy(userId, worksheetId))

  return Number(row?.value ?? 0)
}
