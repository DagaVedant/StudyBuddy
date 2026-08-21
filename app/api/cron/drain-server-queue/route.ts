import {NextResponse} from 'next/server'

import {applyPermanentFailure} from '@/lib/worker/apply'
import {authenticateCron} from '@/lib/api'
import {db} from '@/lib/db'
import {drainServerQueue} from '@/lib/worker/server-job'
import {reapAbandonedJobs} from '@/lib/queue'

export const maxDuration = 300

const JOBS_PER_TICK = 5

export async function GET(request: Request) {
  const auth = authenticateCron(request)
  if (!auth.ok) {
    return NextResponse.json({error: auth.message}, {status: auth.status})
  }

  const reaped = await reapAbandonedJobs(db)
  for (const abandoned of reaped) {
    console.log(
      `[cron] reaped abandoned ${abandoned.stage} job ${abandoned.id} on ` +
        `worksheet ${abandoned.worksheetId}`,
    )
    await applyPermanentFailure(db, abandoned)
  }

  await drainServerQueue(db, JOBS_PER_TICK)

  return NextResponse.json({ok: true, reaped: reaped.length})
}
