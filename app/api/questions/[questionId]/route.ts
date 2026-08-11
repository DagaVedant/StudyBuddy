import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { CHOICE_ORDER } from '@/lib/questions/choice-order'
import { answerChoices, questionTopics, questions } from '@/lib/db/schema'
import { checkReferences, referenceError } from '@/lib/questions/references'
import { hashQuestion, questionInputSchema } from '@/lib/questions/shape'

type Params = { params: Promise<{ questionId: string }> }

type Ownership =
  | { ok: true; userId: string; worksheetId: string }
  | { ok: false; status: 401 | 404 }

/**
 * The question's owner and the worksheet it belongs to.
 *
 * The worksheet id comes back because `pageId` has to be checked against it: a
 * page from another worksheet is a valid foreign key and still the wrong page.
 *
 * 404 for a question that is not yours, deliberately, and the same 404 for one
 * that does not exist: telling the two apart turns an id into a probe.
 *
 * 401 is separate, and used to be folded into that 404. It is not an ownership
 * answer. `fetchJson` navigates to the sign-in page on a 401 and carries the
 * student back afterwards, so collapsing it meant a tab whose session had
 * expired mid-edit reported "Not found" and lost what they had typed, with no
 * way forward. That is the same failure the 401 handling in `fetchJson` was
 * written for; this route was the one that could not produce one.
 */
async function ownsQuestion(questionId: string): Promise<Ownership> {
  const session = await auth()
  if (!session?.user?.id) return { ok: false, status: 401 }

  const [row] = await db
    .select({ userId: questions.userId, worksheetId: questions.worksheetId })
    .from(questions)
    .where(eq(questions.id, questionId))
    .limit(1)

  if (!row || row.userId !== session.user.id) return { ok: false, status: 404 }
  return { ok: true, userId: session.user.id, worksheetId: row.worksheetId }
}

export async function PATCH(request: Request, { params }: Params) {
  const { questionId } = await params

  const owner = await ownsQuestion(questionId)
  if (!owner.ok) {
    return NextResponse.json(
      { error: owner.status === 401 ? 'Unauthorized' : 'Not found' },
      { status: owner.status },
    )
  }

  // Caught to null rather than {}, because every field here is optional and {}
  // parses clean: a truncated or non-JSON body would reach the transaction as an
  // empty patch and answer with ok, having written nothing the client asked for.
  // That is the same shape as the bug in questionInputSchema's choices field,
  // where a body that never mentioned choices parsed to [] and this route
  // deleted every answer the question had.
  const parsed = questionInputSchema.partial().safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid question' }, { status: 400 })
  }

  const input = parsed.data

  // Outside the transaction, for the same reason as the create route: a bad
  // `pageId` or `topicId` is a foreign key violation thrown out of the write,
  // and a 500 loses whatever the student had just typed.
  const references = await checkReferences(db, owner.worksheetId, input)
  if (!references.ok) {
    return NextResponse.json(
      { error: referenceError(references.field!) },
      { status: 400 },
    )
  }

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
          .where(eq(answerChoices.questionId, questionId))
          // The hash is order-sensitive and this is the dedupe identity for
          // the whole pipeline, so an unordered read could hash one untouched
          // question two different ways on two different edits.
          .orderBy(...CHOICE_ORDER))

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

      patch.contentHash = hashQuestion(promptText, choices)
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

  const owner = await ownsQuestion(questionId)
  if (!owner.ok) {
    return NextResponse.json(
      { error: owner.status === 401 ? 'Unauthorized' : 'Not found' },
      { status: owner.status },
    )
  }

  await db.delete(questions).where(eq(questions.id, questionId))
  return NextResponse.json({ ok: true })
}
