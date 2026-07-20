import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { refundTrial } from '@/lib/ai/quota'
import { extractedQuestionSchema } from '@/lib/ai/types'
import type { Db } from '@/lib/dashboard/queries'
import { db } from '@/lib/db'
import { processingJobs, worksheetPages, worksheets } from '@/lib/db/schema'
import { checkpointJob, completeJob, failJob } from '@/lib/queue'
import { authenticateWorker } from '@/lib/worker/auth'
import { persistQuestions } from '@/lib/worker/ingest'

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

      if (worksheet?.tierUsed === 'trial') {
        await refundTrial(client, job.userId, 'worksheets', 1)
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


  const [page] = await db
    .select({ id: worksheetPages.id, worksheetId: worksheetPages.worksheetId })
    .from(worksheetPages)
    .where(eq(worksheetPages.id, body.pageId))
    .limit(1)

  if (!page || page.worksheetId !== job.worksheetId) {
    return NextResponse.json({ error: 'Page does not belong to this job' }, { status: 400 })
  }

  const created = await persistQuestions(client, job, page.id, body.questions)

  await checkpointJob(client, jobId, body.pageNumber / body.totalPages, {
    lastPageNumber: body.pageNumber,
  })

  return NextResponse.json({
    ok: true,
    created,
    duplicates: body.questions.length - created,
  })
}
