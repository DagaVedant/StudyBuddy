import {NextResponse} from 'next/server'
import {readJson} from '@/lib/api'
import {z} from 'zod'
import {authenticateWorker} from '@/lib/worker/jobs'
import {db} from '@/lib/db'
import {heartbeat, markWorkerOffline, queueDepth} from '@/lib/queue'

const schema = z.object({
  workerName: z.string().trim().min(1).max(100),
  modelName: z.string().trim().max(200).nullish(),
  jobsInFlight: z.number().int().min(0).max(64).default(0),
  shuttingDown: z.boolean().default(false),
})

export async function POST(request: Request) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({error: auth.message}, {status: auth.status})
  }

  const parsed = schema.safeParse(await readJson(request))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const workerName = parsed.data.workerName
  const jobsInFlight = parsed.data.jobsInFlight

  let modelName = null
  if (parsed.data.modelName) modelName = parsed.data.modelName

  if (parsed.data.shuttingDown) {
    await markWorkerOffline(db, workerName)
    return NextResponse.json({ok: true})
  }

  await heartbeat(db, workerName, modelName, jobsInFlight)

  const depth = await queueDepth(db, 'operator_gpu')

  return NextResponse.json({ok: true, depth})
}
