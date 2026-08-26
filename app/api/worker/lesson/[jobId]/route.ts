import {NextResponse} from 'next/server'
import {eq} from 'drizzle-orm'
import {authenticateWorker} from '@/lib/worker/jobs'
import {processingJobs} from '@/lib/schema'
import {db} from '@/lib/db'
import {lessonInput} from '@/lib/practice'

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

  if (!job || job.stage !== 'lesson') {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  const topicId = (job.checkpoint as {topicId?: string} | null)?.topicId
  if (!topicId) {
    return NextResponse.json({error: 'Job names no topic'}, {status: 400})
  }

  return NextResponse.json({topicId, ...(await lessonInput(db, topicId))})
}
