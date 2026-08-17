import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { processingJobs } from '@/lib/db/schema'
import { authenticateWorker } from '@/lib/worker/auth'

import {
  handleComplete,
  handleExplanation,
  handleFail,
  handlePageResult,
  handlePageReview,
  handlePhase,
  handleSolution,
} from './handlers'
import { bodySchema } from './schema'

type Params = { params: Promise<{ jobId: string }> }

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

  const [job] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId))
    .limit(1)

  if (!job) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const body = parsed.data

  if (body.action !== 'fail' && job.status !== 'claimed' && job.status !== 'running') {
    return NextResponse.json(
      { error: `Job is ${job.status}, not accepting work`, status: job.status },
      { status: 409 },
    )
  }

  switch (body.action) {
    case 'fail':
      return handleFail(db, jobId, job, body)
    case 'phase':
      return handlePhase(db, jobId, job, body)
    case 'page_review':
      return handlePageReview(db, job, body)
    case 'explanation':
      return handleExplanation(db, job, body)
    case 'solution':
      return handleSolution(db, job, body)
    case 'complete':
      return handleComplete(db, jobId, job)
    case 'page_result':
      return handlePageResult(db, jobId, job, body)
  }
}
