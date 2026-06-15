import { createHash } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { refundTrial } from '@/lib/ai/quota'
import { extractedQuestionSchema } from '@/lib/ai/types'
import type { Db } from '@/lib/dashboard/queries'
import { db } from '@/lib/db'
import {
  answerChoices,
  processingJobs,
  questions,
  worksheetPages,
  worksheets,
} from '@/lib/db/schema'
import { contentHashSource } from '@/lib/questions/shape'
import { checkpointJob, completeJob, failJob } from '@/lib/queue'
import { authenticateWorker } from '@/lib/worker/auth'

type Params = { params: Promise<{ jobId: string }> }

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('page_result'),
    pageId: z.string().min(1),
    pageNumber: z.number().int().min(1),
    totalPages: z.number().int().min(1),
    questions: z.array(extractedQuestionSchema).max(100),
  }),
  z.object({ action: z.literal('complete') }),
  z.object({ action: z.literal('fail'), message: z.string().max(2000) }),
])

/**
 * Where the worker writes results back (spec §3.3).
 *
 * Output is schema-validated here, not just on the worker — a compromised or
 * buggy worker cannot write arbitrary rows.
 */
export async function POST(request: Request, { params }: Params) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status })
  }

  const { jobId } = await params
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const client = db as unknown as Db

  const [job] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId))
    .limit(1)

  if (!job) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const body = parsed.data

  if (body.action === 'fail') {
    const { permanent } = await failJob(client, jobId, body.message)

    if (permanent) {
      const [worksheet] = await db
        .select({ pageCount: worksheets.pageCount, tierUsed: worksheets.tierUsed })
        .from(worksheets)
        .where(eq(worksheets.id, job.worksheetId))
        .limit(1)

      // A job that died for good must not have cost the student their trial.
      if (worksheet?.tierUsed === 'trial') {
        await refundTrial(client, job.userId, 'pages', worksheet.pageCount)
      }

      await db
        .update(worksheets)
        .set({ status: 'failed' })
        .where(eq(worksheets.id, job.worksheetId))
    }

    return NextResponse.json({ ok: true, permanent })
  }

  if (body.action === 'complete') {
    await completeJob(client, jobId)
    await db
      .update(worksheets)
      .set({ status: 'awaiting_review' })
      .where(eq(worksheets.id, job.worksheetId))

    return NextResponse.json({ ok: true })
  }

  /* page_result -------------------------------------------------------- */

  const [page] = await db
    .select({ id: worksheetPages.id, worksheetId: worksheetPages.worksheetId })
    .from(worksheetPages)
    .where(eq(worksheetPages.id, body.pageId))
    .limit(1)

  // The page must belong to the worksheet this job actually claimed.
  if (!page || page.worksheetId !== job.worksheetId) {
    return NextResponse.json({ error: 'Page does not belong to this job' }, { status: 400 })
  }

  const existing = await db
    .select({ ordinal: questions.ordinal })
    .from(questions)
    .where(eq(questions.worksheetId, job.worksheetId))

  let ordinal = existing.reduce((max, row) => Math.max(max, row.ordinal), 0) + 1

  for (const question of body.questions) {
    const contentHash = createHash('sha256')
      .update(contentHashSource(question.prompt_text, question.choices))
      .digest('hex')

    const [row] = await db
      .insert(questions)
      .values({
        userId: job.userId,
        worksheetId: job.worksheetId,
        pageId: page.id,
        ordinal,
        promptText: question.prompt_text,
        questionType: question.question_type,
        bbox: question.bbox,
        userVerified: false,
        answerSource: 'none',
        contentHash,
      })
      .returning({ id: questions.id })

    if (question.choices.length > 0) {
      await db.insert(answerChoices).values(
        question.choices.map((choice) => ({
          questionId: row.id,
          label: choice.label,
          text: choice.text,
          isCorrect: false,
        })),
      )
    }

    ordinal += 1
  }

  await checkpointJob(client, jobId, body.pageNumber / body.totalPages, {
    lastPageNumber: body.pageNumber,
  })

  return NextResponse.json({ ok: true, created: body.questions.length })
}
