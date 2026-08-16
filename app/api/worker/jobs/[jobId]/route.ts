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

  // The job has to still be live. A worker restarted mid-paper still holds the
  // job id it was working on, and nothing stopped it posting pages into a job
  // that had already completed or been reaped: questions appended to a finished
  // worksheet, or a `complete` that walked a failed one back to review.
  //
  // `fail` is exempt. A worker whose job was reaped out from under it is
  // reporting exactly the failure that happened, and refusing that report just
  // loses the error message.
  if (body.action !== 'fail' && job.status !== 'claimed' && job.status !== 'running') {
    return NextResponse.json(
      { error: `Job is ${job.status}, not accepting work`, status: job.status },
      { status: 409 },
    )
  }

  // One handler per action (./handlers.ts). The route's job is authenticating,
  // validating the body, loading the job row, and enforcing that it is still
  // live (everything every action needs regardless of which one it is),
  // and then handing off. What each action actually does lives beside its
  // own reasoning in the handler, not interleaved with the other six here.
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
