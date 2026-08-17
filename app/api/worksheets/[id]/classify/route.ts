import { and, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { resolveProvider } from '@/lib/ai/resolve'
import { applyClassification, isEmbedding, shortlistByVector } from '@/lib/classify'
import { pendingQuestionCount, pendingQuestions } from '@/lib/classify/pending'
import { db } from '@/lib/db'
import { questions, worksheets } from '@/lib/db/schema'
import { guardWorksheet } from '@/lib/upload/guard'
import { clearUntagged } from '@/lib/worker/untagged'

export const maxDuration = 300

export const BROWSER_CLASSIFY_BATCH = 12

type Params = { params: Promise<{ id: string }> }

const schema = z.object({
  items: z
    .array(
      z.object({
        questionId: z.string().min(1),
        embedding: z.array(z.number()),
      }),
    )
    .max(BROWSER_CLASSIFY_BATCH),
})

export async function GET(_request: Request, { params }: Params) {
  const { id: worksheetId } = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({ error: 'Not found' }, { status: guard.status })
  }

  const { executor } = await resolveProvider(db, guard.userId)

  const pending = await pendingQuestions(db, worksheetId, BROWSER_CLASSIFY_BATCH)
  const remaining = await pendingQuestionCount(db, worksheetId)

  if (remaining === 0) {
    await clearUntagged(db, worksheetId)
  }

  return NextResponse.json({
    supported: executor === 'server',
    batchSize: BROWSER_CLASSIFY_BATCH,
    remaining,
    questions: pending,
  })
}

export async function POST(request: Request, { params }: Params) {
  const { id: worksheetId } = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({ error: 'Not found' }, { status: guard.status })
  }

  const parsed = schema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const { provider, executor } = await resolveProvider(db, guard.userId)

  if (executor !== 'server') {
    return NextResponse.json(
      {
        error:
          'Sorting questions into topics needs a cloud API key. Add one in settings.',
      },
      { status: 409 },
    )
  }

  const [worksheet] = await db
    .select({ subjectHint: worksheets.subjectHint })
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  if (!worksheet) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  let applied = 0
  let coarse = 0
  let failed = 0

  for (const item of parsed.data.items) {
    if (!isEmbedding(item.embedding)) {
      failed += 1
      continue
    }

    const [question] = await db
      .select({
        id: questions.id,
        promptText: questions.promptText,
        userId: questions.userId,
      })
      .from(questions)
      .where(
        and(
          eq(questions.id, item.questionId),
          eq(questions.worksheetId, worksheetId),
          eq(questions.userId, guard.userId),
        ),
      )
      .limit(1)

    if (!question) continue

    await db
      .update(questions)
      .set({ embedding: item.embedding })
      .where(eq(questions.id, question.id))

    const candidates = await shortlistByVector(db, item.embedding, {
      subjectHint: worksheet.subjectHint,
    })

    if (candidates.length === 0) {
      failed += 1
      continue
    }

    try {
      const classification = await provider.classifyTopic(
        question.promptText,
        candidates,
      )

      const outcome = await applyClassification(
        db,
        question,
        candidates,
        classification,
      )

      if (outcome.topicId) applied += 1
      if (outcome.coarse) coarse += 1
    } catch (error) {
      failed += 1
      console.error(
        `[classify] question ${question.id} could not be classified:`,
        (error as Error).message,
      )
    }
  }

  const remaining = await pendingQuestions(db, worksheetId, 1)

  if (remaining.length === 0) {
    await clearUntagged(db, worksheetId)
  }

  return NextResponse.json({
    applied,
    coarse,
    failed,
    done: remaining.length === 0,
  })
}
