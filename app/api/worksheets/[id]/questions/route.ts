import { createHash } from 'node:crypto'

import { asc, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { answerChoices, questionTopics, questions } from '@/lib/db/schema'
import { contentHashSource, questionInputSchema } from '@/lib/questions/shape'
import { guardWorksheet } from '@/lib/upload/guard'

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Params) {
  const { id: worksheetId } = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({ error: 'Not found' }, { status: guard.status })
  }

  const rows = await db
    .select()
    .from(questions)
    .where(eq(questions.worksheetId, worksheetId))
    .orderBy(asc(questions.ordinal))

  const choices = await db
    .select()
    .from(answerChoices)
    .innerJoin(questions, eq(answerChoices.questionId, questions.id))
    .where(eq(questions.worksheetId, worksheetId))

  const topics = await db
    .select()
    .from(questionTopics)
    .innerJoin(questions, eq(questionTopics.questionId, questions.id))
    .where(eq(questions.worksheetId, worksheetId))

  return NextResponse.json({
    questions: rows.map((question) => ({
      ...question,
      choices: choices
        .filter((row) => row.answer_choices.questionId === question.id)
        .map((row) => row.answer_choices),
      topicId:
        topics.find((row) => row.question_topics.questionId === question.id)
          ?.question_topics.topicId ?? null,
    })),
  })
}

export async function POST(request: Request, { params }: Params) {
  const { id: worksheetId } = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({ error: 'Not found' }, { status: guard.status })
  }

  const parsed = questionInputSchema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid question' },
      { status: 400 },
    )
  }

  const input = parsed.data

  const contentHash = createHash('sha256')
    .update(contentHashSource(input.promptText, input.choices))
    .digest('hex')

  const questionId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(questions)
      .values({
        userId: guard.userId,
        worksheetId,
        pageId: input.pageId ?? null,
        ordinal: input.ordinal,
        promptText: input.promptText,
        questionType: input.questionType,
        bbox: input.bbox ?? null,
        correctAnswer: input.correctAnswer ?? null,
        answerSource: input.correctAnswer ? 'user_key' : 'none',
        userVerified: true,
        contentHash,
      })
      .returning({ id: questions.id })

    if (input.choices.length > 0) {
      await tx.insert(answerChoices).values(
        input.choices.map((choice) => ({
          questionId: row.id,
          label: choice.label,
          text: choice.text,
          isCorrect: choice.isCorrect,
        })),
      )
    }

    if (input.topicId) {
      await tx.insert(questionTopics).values({
        questionId: row.id,
        topicId: input.topicId,
        assignedBy: 'user',
        isPrimary: true,
        confidence: 1,
      })
    }

    return row.id
  })

  return NextResponse.json({ questionId }, { status: 201 })
}
