import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { classificationSchema } from '@/lib/ai/types'
import { applyClassification, shortlistTopics } from '@/lib/classify'
import type { Db } from '@/lib/dashboard/queries'
import { db } from '@/lib/db'
import { questionTopics, questions, worksheets } from '@/lib/db/schema'
import { authenticateWorker } from '@/lib/worker/auth'

type Params = { params: Promise<{ worksheetId: string }> }

export async function GET(request: Request, { params }: Params) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status })
  }

  const { worksheetId } = await params
  const client = db as unknown as Db

  const [worksheet] = await db
    .select({ subjectHint: worksheets.subjectHint })
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  if (!worksheet) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const rows = await db
    .select({
      id: questions.id,
      promptText: questions.promptText,
    })
    .from(questions)
    .where(eq(questions.worksheetId, worksheetId))
    .limit(100)

  const assigned = await db
    .select({ questionId: questionTopics.questionId })
    .from(questionTopics)
    .innerJoin(questions, eq(questionTopics.questionId, questions.id))
    .where(eq(questions.worksheetId, worksheetId))

  const done = new Set(assigned.map((row) => row.questionId))
  const pending = rows.filter((row) => !done.has(row.id))

  const batch = []
  for (const question of pending) {
    batch.push({
      questionId: question.id,
      promptText: question.promptText,
      candidates: await shortlistTopics(
        client,
        question.promptText,
        worksheet.subjectHint,
      ),
    })
  }

  return NextResponse.json({ batch })
}

const resultsSchema = z.object({
  results: z
    .array(
      z.object({
        questionId: z.string().min(1),
        classification: classificationSchema,
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

  const client = db as unknown as Db

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

    const candidates = await shortlistTopics(
      client,
      question.promptText,
      worksheet.subjectHint,
    )

    try {
      const outcome = await applyClassification(
        client,
        question,
        candidates,
        entry.classification,
      )
      if (outcome.topicId) applied += 1
      if (outcome.coarse) coarse += 1
    } catch {

    }
  }

  return NextResponse.json({ ok: true, applied, coarse })
}
