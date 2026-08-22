import {NextResponse} from 'next/server'
import {eq} from 'drizzle-orm'
import {z} from 'zod'
import {authenticateWorker} from '@/lib/worker/jobs'
import {claimJob, heartbeat, queueDepth, reapAbandonedJobs} from '@/lib/queue'
import {worksheets} from '@/lib/schema'
import {applyPermanentFailure} from '@/lib/worker/apply'
import {db} from '@/lib/db'
import {pagesForJob} from '@/lib/worker/pipeline'

const claimSchema = z.object({
  workerName: z.string().trim().min(1).max(100),
  modelName: z.string().trim().max(200).nullish(),
  jobsInFlight: z.number().int().min(0).max(64).default(0),
})

export async function POST(request: Request) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({error: auth.message}, {status: auth.status})
  }

  const parsed = claimSchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const {workerName, modelName, jobsInFlight} = parsed.data

  const workerId = await heartbeat(db, workerName, modelName ?? null, jobsInFlight)

  for (const abandoned of await reapAbandonedJobs(db)) {
    console.log(
      `[queue] reaped abandoned ${abandoned.stage} job ${abandoned.id} on ` +
        `worksheet ${abandoned.worksheetId}`,
    )
    await applyPermanentFailure(db, abandoned)
  }

  const job = await claimJob(db, 'operator_gpu', workerId)

  if (!job) {
    const depth = await queueDepth(db, 'operator_gpu')
    return NextResponse.json({job: null, depth})
  }

  await heartbeat(db, workerName, modelName ?? null, jobsInFlight + 1)

  const [worksheet] = await db
    .select({expectedQuestionCount: worksheets.expectedQuestionCount})
    .from(worksheets)
    .where(eq(worksheets.id, job.worksheetId))
    .limit(1)

  return NextResponse.json({
    job: {
      id: job.id,
      worksheetId: job.worksheetId,
      stage: job.stage,
      attemptCount: job.attemptCount,
      expectedQuestionCount: worksheet?.expectedQuestionCount ?? null,
      checkpoint: job.checkpoint,
    },
    pages: await pagesForJob(db, job.worksheetId),
  })
}
