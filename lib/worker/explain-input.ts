import { and, desc, eq } from 'drizzle-orm'

import { answerChoices, attempts, questions } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'
import { CHOICE_ORDER } from '@/lib/questions/sql'

export interface ExplainInput {
  questionId: string
  attemptId: string | null
  promptText: string
  choices: { label: string; text: string }[]
  correctAnswer: string | null
  studentAnswer: string | null
}

export async function explainInput(
  db: Db,
  userId: string,
  questionId: string,
): Promise<ExplainInput | null> {
  const [question] = await db
    .select()
    .from(questions)
    .where(and(eq(questions.id, questionId), eq(questions.userId, userId)))
    .limit(1)

  if (!question) return null

  const choices = await db
    .select()
    .from(answerChoices)
    .where(eq(answerChoices.questionId, question.id))
    .orderBy(...CHOICE_ORDER)

  const [lastAttempt] = await db
    .select()
    .from(attempts)
    .where(and(eq(attempts.userId, userId), eq(attempts.questionId, question.id)))
    .orderBy(desc(attempts.createdAt))
    .limit(1)

  const studentAnswer =
    choices.find((choice) => choice.id === lastAttempt?.selectedChoiceId)?.label ??
    lastAttempt?.freeTextAnswer ??
    null

  return {
    questionId: question.id,
    attemptId: lastAttempt?.id ?? null,
    promptText: question.promptText,
    choices: choices.map((choice) => ({ label: choice.label, text: choice.text })),
    correctAnswer:
      choices.find((choice) => choice.isCorrect)?.label ?? question.correctAnswer,
    studentAnswer,
  }
}
