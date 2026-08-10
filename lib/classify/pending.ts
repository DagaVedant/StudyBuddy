import { and, asc, eq, notExists } from 'drizzle-orm'

import type { Db } from '@/lib/db/types'
import { questionTopics, questions } from '@/lib/db/schema'

/**
 * How many questions one request hands over.
 *
 * The worker asks again until it stops being shown anything it has not already
 * tried, so this bounds one round trip rather than the paper.
 */
export const PENDING_PAGE_SIZE = 100

export interface PendingQuestion {
  id: string
  promptText: string
}

/**
 * The next page of questions on this worksheet that still have no topic.
 *
 * Three things here used to be somewhere else, and each of them cost a real
 * paper questions.
 *
 * The cap was on an unordered select of every question on the worksheet.
 * Postgres may return rows in whatever order suits it, so on a 114-question
 * paper *which* 100 were considered was decided by nothing in particular and
 * could differ between two calls. Fourteen questions went untagged and there
 * was no way to say which fourteen.
 *
 * The already-tagged ones were filtered out afterwards, in JS, so they spent
 * places inside the cap. This is the resume path as much as the first run: a
 * worksheet with 100 questions already classified handed back an empty page,
 * which reads exactly like "nothing left to do", and the remaining questions
 * were never classified at all.
 *
 * And the tagged set was fetched with a second query and a join over the whole
 * worksheet, to build a set that was then used once. `not exists` says the same
 * thing to the planner, which can stop at the first matching row.
 */
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
    // `id` as the tiebreak because `ordinal` is the number printed on the page,
    // and a paper can print the same one twice.
    .orderBy(asc(questions.ordinal), asc(questions.id))
    .limit(limit)
}
