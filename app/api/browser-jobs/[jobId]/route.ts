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
} from '../../worker/jobs/[jobId]/handlers'
import { bodySchema } from '../../worker/jobs/[jobId]/schema'

type Params = { params: Promise<{ jobId: string }> }

/**
 * The Tier C equivalent of `POST /api/worker/jobs/[jobId]`.
 *
 * Deliberately the same handlers and the same body schema, imported rather
 * than reimplemented. What a page result means, when a job may be written to,
 * and how a checkpoint is recorded are properties of the queue, not of who is
 * doing the work, and the operator's route was already split into a
 * dispatcher, its handlers and its schema so a second dispatcher could exist
 * without copying any of it.
 *
 * What differs is only the door: a session instead of `WORKER_API_TOKEN`, plus
 * the two checks that a token makes unnecessary. The worker's token proves it
 * is the operator's machine and therefore entitled to any job; a session
 * proves only who the student is, so this has to establish that the job is
 * theirs and that it is one a browser was ever meant to run.
 */
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

  // One reply for "no such job" and for "not yours", so this cannot be used to
  // find out which job ids exist.
  if (!job || job.userId !== session.user.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // A session is entitled to this user's browser jobs and to nothing else.
  // Without this, a student could post results into their own Tier 0 job and
  // hand the server whatever questions they liked in place of what the
  // operator's GPU actually read.
  if (job.executor !== 'browser') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const body = parsed.data

  // Same rule as the operator's route: the job has to still be live, and
  // `fail` is exempt because a worker whose job was reaped is reporting
  // exactly the failure that happened.
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
