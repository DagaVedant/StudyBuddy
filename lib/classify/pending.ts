import { and, asc, eq, notExists } from 'drizzle-orm'

import type { Db } from '@/lib/db/types'
import { questionTopics, questions } from '@/lib/db/schema'

export const PENDING_PAGE_SIZE = 100

export interface PendingQuestion {
  id: string
  promptText: string
}

export async function pendingQuestions(
  db: Db,
  worksheetId: string,
  limit: number = PENDING_PAGE_SIZE,
): Promise<PendingQuestion[]> {
  return db
    .select({ id: questions.id, promptText: questions.promptText })
    .from(questions)
    .where(
      and(
        eq(questions.worksheetId, worksheetId),
        notExists(
          db
            .select({ questionId: questionTopics.questionId })
            .from(questionTopics)
            .where(eq(questionTopics.questionId, questions.id)),
        ),
      ),
    )
    .orderBy(asc(questions.ordinal), asc(questions.id))
    .limit(limit)
}
