import {NextResponse} from 'next/server'
import {eq} from 'drizzle-orm'
import {authenticateWorker} from '@/lib/worker/jobs'
import {processingJobs} from '@/lib/schema'
import {db} from '@/lib/db'
import {explainInput} from '@/lib/worker/solutions'

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

  if (!job || job.stage !== 'explain') {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  const checkpoint = job.checkpoint as {questionId?: string} | null

  let questionId = undefined
  if (checkpoint) questionId = checkpoint.questionId
  if (!questionId) {
    return NextResponse.json({error: 'Job names no question'}, {status: 400})
  }

  const input = await explainInput(db, job.userId, questionId)
  if (!input) {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  return NextResponse.json(input)
}
