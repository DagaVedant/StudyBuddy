import { and, asc, count, eq, notExists } from 'drizzle-orm'

import type { Db } from '@/lib/db/types'
import { questionTopics, questions } from '@/lib/db/schema'

export const PENDING_PAGE_SIZE = 100

export interface PendingQuestion {
  id: string
  promptText: string
}

function untagged(db: Db, worksheetId: string) {
  return and(
    eq(questions.worksheetId, worksheetId),
    notExists(
      db
        .select({ questionId: questionTopics.questionId })
        .from(questionTopics)
        .where(eq(questionTopics.questionId, questions.id)),
    ),
  )
}

export async function pendingQuestions(
  db: Db,
  worksheetId: string,
  limit: number = PENDING_PAGE_SIZE,
): Promise<PendingQuestion[]> {
  return db
    .select({ id: questions.id, promptText: questions.promptText })
    .from(questions)
    .where(untagged(db, worksheetId))
    .orderBy(asc(questions.ordinal), asc(questions.id))
    .limit(limit)
}

export async function pendingQuestionCount(
  db: Db,
  worksheetId: string,
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(questions)
    .where(untagged(db, worksheetId))

  return Number(row?.value ?? 0)
}
