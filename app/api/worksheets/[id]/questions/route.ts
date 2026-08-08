import { asc, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { answerChoices, questionTopics, questions } from '@/lib/db/schema'
import { hashQuestion, questionInputSchema } from '@/lib/questions/shape'
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

  // Grouped once rather than scanned per question: on a 114-question paper the
  // filter-and-find pair was two linear passes over every choice and every
  // topic row, for every row rendered.
  const choicesFor = new Map<string, (typeof choices)[number]['answer_choices'][]>()
  for (const row of choices) {
    const list = choicesFor.get(row.answer_choices.questionId)
    if (list) list.push(row.answer_choices)
    else choicesFor.set(row.answer_choices.questionId, [row.answer_choices])
  }

  const topicFor = new Map<string, string>()
  for (const row of topics) {
    if (!topicFor.has(row.question_topics.questionId)) {
      topicFor.set(row.question_topics.questionId, row.question_topics.topicId)
    }
  }

  return NextResponse.json({
    questions: rows.map((question) => ({
      ...question,
      choices: choicesFor.get(question.id) ?? [],
      topicId: topicFor.get(question.id) ?? null,
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

  const contentHash = hashQuestion(input.promptText, input.choices)

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
