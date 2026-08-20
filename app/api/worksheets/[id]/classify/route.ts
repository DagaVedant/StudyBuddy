import { and, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { ollamaConfig } from '@/lib/ai/ollama-config'
import { resolveProvider } from '@/lib/ai/resolve'
import { classificationSchema } from '@/lib/ai/types'
import { applyClassification, isEmbedding, shortlistByVector } from '@/lib/classify'
import { pendingQuestionCount, pendingQuestions } from '@/lib/classify/pending'
import { db } from '@/lib/db'
import { questions, worksheets } from '@/lib/db/schema'
import { guardWorksheet } from '@/lib/upload/guard'
import { clearUntagged } from '@/lib/worker/status'

export const maxDuration = 300

export const BROWSER_CLASSIFY_BATCH = 12

type Params = { params: Promise<{ id: string }> }

const itemsSchema = z
  .array(
    z.object({
      questionId: z.string().min(1),
      embedding: z.array(z.number()),
    }),
  )
  .max(BROWSER_CLASSIFY_BATCH)

const candidateSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
})

const schema = z.union([
  z.object({ action: z.literal('shortlist'), items: itemsSchema }),
  z.object({
    action: z.literal('apply'),
    results: z
      .array(
        z.object({
          questionId: z.string().min(1),
          classification: classificationSchema,
          candidates: z.array(candidateSchema).max(64),
          proposalEmbedding: z.array(z.number()).optional(),
        }),
      )
      .max(BROWSER_CLASSIFY_BATCH),
  }),
  z.object({ items: itemsSchema }),
])

type Body = z.infer<typeof schema>

async function ownedQuestion(worksheetId: string, userId: string, questionId: string) {
  const [question] = await db
    .select({
      id: questions.id,
      promptText: questions.promptText,
      userId: questions.userId,
    })
    .from(questions)
    .where(
      and(
        eq(questions.id, questionId),
        eq(questions.worksheetId, worksheetId),
        eq(questions.userId, userId),
      ),
    )
    .limit(1)

  return question
}

async function finish(worksheetId: string) {
  const remaining = await pendingQuestions(db, worksheetId, 1)

  if (remaining.length === 0) {
    await clearUntagged(db, worksheetId)
  }

  return remaining.length === 0
}

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
    supported: executor === 'server' || executor === 'browser',
    executor,
    batchSize: BROWSER_CLASSIFY_BATCH,
    remaining,
    questions: pending,
    ollama: executor === 'browser' ? await ollamaConfig(db, guard.userId) : null,
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

  const body: Body = parsed.data
  const { provider, executor } = await resolveProvider(db, guard.userId)

  const [worksheet] = await db
    .select({ subjectHint: worksheets.subjectHint })
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  if (!worksheet) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  if ('action' in body) {
    if (executor !== 'browser') {
      return NextResponse.json(
        {
          error:
            'Picking the topic on this machine is for accounts running their own Ollama.',
        },
        { status: 409 },
      )
    }

    if (body.action === 'shortlist') {
      const batch = []

      for (const item of body.items) {
        if (!isEmbedding(item.embedding)) continue

        const question = await ownedQuestion(worksheetId, guard.userId, item.questionId)
        if (!question) continue

        await db
          .update(questions)
          .set({ embedding: item.embedding })
          .where(eq(questions.id, question.id))

        batch.push({
          questionId: question.id,
          promptText: question.promptText,
          candidates: await shortlistByVector(db, item.embedding, {
            subjectHint: worksheet.subjectHint,
          }),
        })
      }

      return NextResponse.json({ batch })
    }

    let applied = 0
    let coarse = 0
    let failed = 0

    for (const entry of body.results) {
      const question = await ownedQuestion(worksheetId, guard.userId, entry.questionId)
      if (!question) continue

      try {
        const outcome = await applyClassification(
          db,
          question,
          entry.candidates,
          entry.classification,
          isEmbedding(entry.proposalEmbedding) ? entry.proposalEmbedding : undefined,
        )

        if (outcome.topicId) applied += 1
        if (outcome.coarse) coarse += 1
      } catch (error) {
        failed += 1
        console.error(
          `[classify] question ${question.id} could not be tagged:`,
          (error as Error).message,
        )
      }
    }

    return NextResponse.json({
      applied,
      coarse,
      failed,
      done: await finish(worksheetId),
    })
  }

  if (executor !== 'server') {
    return NextResponse.json(
      {
        error:
          'Sorting questions into topics needs a cloud API key or your own Ollama. Add one in settings.',
      },
      { status: 409 },
    )
  }

  let applied = 0
  let coarse = 0
  let failed = 0

  for (const item of body.items) {
    if (!isEmbedding(item.embedding)) {
      failed += 1
      continue
    }

    const question = await ownedQuestion(worksheetId, guard.userId, item.questionId)
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

  return NextResponse.json({
    applied,
    coarse,
    failed,
    done: await finish(worksheetId),
  })
}
