import {NextResponse} from 'next/server'
import {eq} from 'drizzle-orm'
import {bodySchema, handleComplete, handleExplanation, handleFail, handlePageResult, handlePageReview, handlePhase, handleSolution} from '@/lib/worker/jobs'
import {auth} from '@/auth'
import {db} from '@/lib/db'
import {processingJobs} from '@/lib/schema'

async function postJobid(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({error: 'Unauthorized'}, {status: 401})
  }

  const {jobId} = await params
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const [job] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId))
    .limit(1)

  if (!job || job.userId !== session.user.id || job.executor !== 'browser') {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  const body = parsed.data

  if (body.action !== 'fail' && job.status !== 'claimed' && job.status !== 'running') {
    return NextResponse.json(
      {error: `Job is ${job.status}, not accepting work`, status: job.status},
      {status: 409},
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

export {postJobid as POST}
