import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { processingJobs } from '@/lib/db/schema'

import {
  handleComplete,
  handleExplanation,
  handleFail,
  handlePageResult,
  handlePageReview,
  handlePhase,
  handleSolution,
} from '@/lib/worker/jobs'
import { bodySchema } from '@/lib/worker/jobs'

type Params = { params: Promise<{ jobId: string }> }

export async function POST(request: Request, { params }: Params) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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

  if (!job || job.userId !== session.user.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  if (job.executor !== 'browser') {
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
      return handleSolution(db, jobId, job, body)
    case 'complete':
      return handleComplete(db, jobId, job)
    case 'page_result':
      return handlePageResult(db, jobId, job, body)
  }
}
