import {NextResponse} from 'next/server'
import {eq} from 'drizzle-orm'
import {authenticateWorker} from '@/lib/worker/jobs'
import {processingJobs} from '@/lib/schema'
import {db} from '@/lib/db'
import {practiceInput} from '@/lib/practice'

export async function GET(
  request: Request,
  {params}: {params: Promise<{jobId: string}>},
) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({error: auth.message}, {status: auth.status})
  }

  const {jobId} = await params

  const [job] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId))
    .limit(1)

  if (!job || job.stage !== 'practice') {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  const checkpoint = job.checkpoint as {topicId?: string; count?: number} | null

  let topicId = undefined
  let count = undefined

  if (checkpoint) {
    topicId = checkpoint.topicId
    count = checkpoint.count
  }

  if (!topicId) {
    return NextResponse.json({error: 'Job names no topic'}, {status: 400})
  }

  const input = await practiceInput(db, {userId: job.userId, topicId, count})

  return NextResponse.json({topicId, ...input})
}
