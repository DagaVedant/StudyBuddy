import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { classificationSchema } from '@/lib/ai/types'
import { applyClassification, isEmbedding } from '@/lib/classify'
import { pendingQuestions } from '@/lib/classify/pending'
import { db } from '@/lib/db'
import { questions, worksheets } from '@/lib/db/schema'
import { authenticateWorker } from '@/lib/worker/auth'

type Params = { params: Promise<{ worksheetId: string }> }

/**
 * Hands back the questions still needing a topic, and nothing more.
 *
 * Shortlisting used to happen here, which meant embedding here, and this
 * server cannot load the embedding model. The worker embeds these itself and
 * posts the vectors to ./shortlist to get candidates back.
 *
 * One page at a time, and the worker keeps asking until a page holds nothing it
 * has not already tried. See {@link pendingQuestions} for what the page used to
 * leave out.
 */
export async function GET(request: Request, { params }: Params) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status })
  }

  const { worksheetId } = await params

  const [worksheet] = await db
    .select({ subjectHint: worksheets.subjectHint })
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  if (!worksheet) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  return NextResponse.json({
    subjectHint: worksheet.subjectHint,
    questions: await pendingQuestions(db, worksheetId),
  })
}

const candidateSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
})

const resultsSchema = z.object({
  results: z
    .array(
      z.object({
        questionId: z.string().min(1),
        classification: classificationSchema,
        // The shortlist the worker actually classified against, sent back so
        // this route does not have to rebuild it, which it cannot do without
        // an embedding model.
        candidates: z.array(candidateSchema).max(64),
        // Consulted only when the result is coarse enough to raise a proposal.
        proposalEmbedding: z.array(z.number()).optional(),
      }),
    )
    .max(100),
})

export async function POST(request: Request, { params }: Params) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status })
  }

  const { worksheetId } = await params
  const parsed = resultsSchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }


  const [worksheet] = await db
    .select({ id: worksheets.id })
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  if (!worksheet) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  let applied = 0
  let coarse = 0

  for (const entry of parsed.data.results) {

    const [question] = await db
      .select({
        id: questions.id,
        promptText: questions.promptText,
        userId: questions.userId,
        worksheetId: questions.worksheetId,
      })
      .from(questions)
      .where(eq(questions.id, entry.questionId))
      .limit(1)

    if (!question || question.worksheetId !== worksheetId) continue

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
    } catch {

    }
  }

  return NextResponse.json({ ok: true, applied, coarse })
}
