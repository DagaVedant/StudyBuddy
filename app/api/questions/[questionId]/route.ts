import { createHash } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { answerChoices, questionTopics, questions } from '@/lib/db/schema'
import { contentHashSource, questionInputSchema } from '@/lib/questions/shape'

type Params = { params: Promise<{ questionId: string }> }

async function ownsQuestion(questionId: string) {
  const session = await auth()
  if (!session?.user?.id) return null

  const [row] = await db
    .select({ userId: questions.userId })
    .from(questions)
    .where(eq(questions.id, questionId))
    .limit(1)

  if (!row || row.userId !== session.user.id) return null
  return session.user.id
}

export async function PATCH(request: Request, { params }: Params) {
  const { questionId } = await params

  if (!(await ownsQuestion(questionId))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const parsed = questionInputSchema.partial().safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid question' }, { status: 400 })
  }

  const input = parsed.data

  await db.transaction(async (tx) => {
    const patch: Record<string, unknown> = {}

    if (input.promptText !== undefined) patch.promptText = input.promptText
    if (input.questionType !== undefined) patch.questionType = input.questionType
    if (input.ordinal !== undefined) patch.ordinal = input.ordinal
    if (input.bbox !== undefined) patch.bbox = input.bbox ?? null
    if (input.pageId !== undefined) patch.pageId = input.pageId ?? null
    if (input.userVerified !== undefined) patch.userVerified = input.userVerified

    if (input.correctAnswer !== undefined) {
      patch.correctAnswer = input.correctAnswer ?? null
      patch.answerSource = input.correctAnswer ? 'user_key' : 'none'
    }

    if (input.promptText !== undefined || input.choices !== undefined) {
      const choices =
        input.choices ??
        (await tx
          .select({ text: answerChoices.text })
          .from(answerChoices)
          .where(eq(answerChoices.questionId, questionId)))

      const promptText =
        input.promptText ??
        (
          await tx
            .select({ promptText: questions.promptText })
            .from(questions)
            .where(eq(questions.id, questionId))
            .limit(1)
        )[0]?.promptText ??
        ''

      patch.contentHash = createHash('sha256')
        .update(contentHashSource(promptText, choices))
        .digest('hex')
    }

    if (Object.keys(patch).length > 0) {
      await tx.update(questions).set(patch).where(eq(questions.id, questionId))
    }

    if (input.choices !== undefined) {
      await tx.delete(answerChoices).where(eq(answerChoices.questionId, questionId))
      if (input.choices.length > 0) {
        await tx.insert(answerChoices).values(
          input.choices.map((choice) => ({
            questionId,
            label: choice.label,
            text: choice.text,
            isCorrect: choice.isCorrect,
          })),
        )
      }
    }

    if (input.topicId !== undefined) {
      await tx.delete(questionTopics).where(eq(questionTopics.questionId, questionId))
      if (input.topicId) {
        await tx.insert(questionTopics).values({
          questionId,
          topicId: input.topicId,
          assignedBy: 'user',
          isPrimary: true,
          confidence: 1,
        })
      }
    }
  })

  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: Request, { params }: Params) {
  const { questionId } = await params

  if (!(await ownsQuestion(questionId))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  await db.delete(questions).where(eq(questions.id, questionId))
  return NextResponse.json({ ok: true })
}
