import { NextResponse } from 'next/server'

import { authenticateCron } from '@/lib/cron-auth'
import { db } from '@/lib/db'
import { reapAbandonedJobs } from '@/lib/queue'
import { applyPermanentFailure } from '@/lib/worker/fail'
import { drainServerQueue } from '@/lib/worker/server-job'

/**
 * The external drain finding 7 named as missing.
 *
 * `drainServerQueue` otherwise only ran from the `after()` of whichever
 * request happened to enqueue a Tier B job
 * (app/api/worksheets/[id]/complete/route.ts), sharing that request's
 * `maxDuration`. A job cut off past its retry ceiling, or one enqueued by a
 * request whose `after()` never got to run at all, waited on some unrelated
 * student's upload to trigger the next drain - or never got picked up if no
 * one else happened to upload anything. vercel.json runs this on its own
 * schedule with a whole invocation's budget to itself, so a Tier B backlog
 * clears even with no other traffic.
 */
export const maxDuration = 300

/**
 * How many jobs one tick takes.
 *
 * The request-triggered drain defaults to 1, guarded there because `after()`
 * shares its budget with the request that started it (lib/worker/server-job.ts).
 * This invocation shares its budget with nothing, so it can afford several;
 * one that does get cut off mid-job just resumes from its checkpoint on the
 * next tick rather than losing the work.
 */
const JOBS_PER_TICK = 5

export async function GET(request: Request) {
  const auth = authenticateCron(request)
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status })
  }

  // The GPU worker's own poll (app/api/worker/claim/route.ts) was the only
  // place this ran before: a job that died past its retry ceiling without
  // ever reporting failure sat claimed until something GPU-side happened to
  // ask. reapAbandonedJobs carries no executor filter, so this also catches a
  // Tier B job whose after() crashed before it could fail itself cleanly.
  const reaped = await reapAbandonedJobs(db)
  for (const abandoned of reaped) {
    console.log(
      `[cron] reaped abandoned ${abandoned.stage} job ${abandoned.id} on ` +
        `worksheet ${abandoned.worksheetId}`,
    )
    // The same path a reported failure takes, so a job that dies silently and
    // one that dies loudly leave the account in the same state.
    await applyPermanentFailure(db, abandoned)
  }

  await drainServerQueue(db, JOBS_PER_TICK)

  return NextResponse.json({ ok: true, reaped: reaped.length })
}
