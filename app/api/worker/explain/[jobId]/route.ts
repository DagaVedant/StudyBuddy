import { and, desc, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { CHOICE_ORDER } from '@/lib/questions/sql'
import { answerChoices, attempts, processingJobs, questions } from '@/lib/db/schema'
import { authenticateWorker } from '@/lib/worker/auth'

type Params = { params: Promise<{ jobId: string }> }

export async function GET(request: Request, { params }: Params) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status })
  }

  const { jobId } = await params

  const [job] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId))
    .limit(1)

  if (!job || job.stage !== 'explain') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const questionId = (job.checkpoint as { questionId?: string } | null)?.questionId
  if (!questionId) {
    return NextResponse.json({ error: 'Job names no question' }, { status: 400 })
  }

  const [question] = await db
    .select()
    .from(questions)
    .where(and(eq(questions.id, questionId), eq(questions.userId, job.userId)))
    .limit(1)

  if (!question) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const choices = await db
    .select()
    .from(answerChoices)
    .where(eq(answerChoices.questionId, question.id))
    .orderBy(...CHOICE_ORDER)

  const [lastAttempt] = await db
    .select()
    .from(attempts)
    .where(and(eq(attempts.userId, job.userId), eq(attempts.questionId, question.id)))
    .orderBy(desc(attempts.createdAt))
    .limit(1)

  const studentAnswer =
    choices.find((choice) => choice.id === lastAttempt?.selectedChoiceId)?.label ??
    lastAttempt?.freeTextAnswer ??
    null

  return NextResponse.json({
    questionId: question.id,
    attemptId: lastAttempt?.id ?? null,
    promptText: question.promptText,
    choices: choices.map((choice) => ({ label: choice.label, text: choice.text })),
    correctAnswer:
      choices.find((choice) => choice.isCorrect)?.label ?? question.correctAnswer,
    studentAnswer,
  })
}
