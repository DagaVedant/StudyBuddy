import { and, asc, eq, inArray, sql } from 'drizzle-orm'

import { answerChoices, attempts, questions, worksheets } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'
import { CHOICE_ORDER } from '@/lib/questions/choice-order'

import type { ExportQuestion } from './csv'

/**
 * How many questions one export can carry.
 *
 * Blooket publishes no ceiling of its own, so this is ours: a bound on how much
 * a single request will hold in memory, not a claim about what Blooket accepts.
 * It sits far above a realistic year of marked worksheets, and the route
 * reports how many rows it wrote so a student who somehow passes it can see
 * that the file is short.
 */
export const EXPORT_LIMIT = 1000

/**
 * Questions this user has ever got wrong, or got right without knowing why.
 *
 * `unsure` is the markup screen's "Right, but I guessed", and a guess is a
 * question you cannot do: the mark landed on the paper, and it landed by luck.
 * It belongs in a drilling set for exactly the reason a miss does, and leaving
 * it out meant the set quietly agreed with the guess.
 *
 * Ever, not most recently. A question missed in markup and later answered
 * correctly in review is still a question worth drilling, and it is the one a
 * student would be most surprised to find missing from a set they asked for by
 * the name "everything I got wrong".
 *
 * Written as `exists` rather than a join because a question can carry many
 * attempts: markup writes one and every review sitting writes another, so
 * joining the tables would repeat a question once per time it was answered.
 */
function everMissed(userId: string) {
  return sql`exists (
    select 1 from ${attempts}
    where ${attempts.questionId} = ${questions.id}
      and ${attempts.userId} = ${userId}
      and ${attempts.outcome} in ('wrong', 'unsure')
  )`
}

/**
 * The whole filter, in one place so the count and the export cannot drift.
 *
 * Scoped by `questions.user_id` rather than by the worksheet's owner, so a
 * worksheet id belonging to somebody else selects nothing even if the caller
 * forgot to check. The routes check anyway; this is the second lock.
 */
function missedBy(userId: string, worksheetId?: string) {
  return and(
    eq(questions.userId, userId),
    worksheetId ? eq(questions.worksheetId, worksheetId) : undefined,
    everMissed(userId),
  )
}

export interface MissedFilter {
  /** One paper's worth. Omitted, it is every paper the student has marked. */
  worksheetId?: string
  limit?: number
}

/**
 * Deliberately not filtered by `IS_QUESTION`, unlike every count on screen.
 *
 * That predicate is a display rule that rejects real but terse questions
 * ("Solve for x."), and leaving one of those out of a study set is worse than
 * letting a stray row through. Nothing strays through in practice anyway: the
 * page furniture it exists to hide has no answer key and no choices, so the
 * exporter drops it as `no-answer` on its own.
 */
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
    // Oldest paper first, then the order the questions were printed in, so a
    // set reads like the worksheets it came from rather than like a shuffle.
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
    // Position is not stored, so label order is the question's order. The
    // review screen resolves it the same way, and the two have to agree: the
    // answer numbers this export writes are positions in this list.
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

/**
 * How many questions {@link getMissedQuestions} would return, ignoring the
 * limit. Counts questions rather than wrong attempts, which is what the
 * dashboard and the worksheets page count, so the two numbers differ for
 * anything missed again in review. This is the one the export can honour.
 */
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
