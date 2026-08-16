import { eq } from 'drizzle-orm'
import { after, NextResponse } from 'next/server'

import { consumeTrial } from '@/lib/ai/quota'
import { resolveProvider } from '@/lib/ai/resolve'
import { db } from '@/lib/db'
import { worksheets } from '@/lib/db/schema'
import {
  MAX_IN_FLIGHT_EXTRACTS,
  enqueueJob,
  inFlightExtractCount,
  workerStatus,
} from '@/lib/queue'
import { claimWorksheetForCompletion, transitionWorksheet } from '@/lib/upload/claim'
import { guardWorksheet } from '@/lib/upload/guard'
import { drainServerQueue } from '@/lib/worker/server-job'

/**
 * Ceiling for this invocation, and therefore for the `after()` callback below.
 *
 * Next's own docs are explicit that `after` is bounded by `maxDuration` rather
 * than running free once the response is sent, so a Tier B extraction started
 * there gets whatever is left of this budget. The default is far shorter than
 * a worksheet takes, which is what made a long extraction die partway and
 * retry from its checkpoint.
 *
 * 300 is the ceiling on Vercel's Pro plan; a job that needs longer than five
 * minutes is one the checkpoint is there to resume.
 */
export const maxDuration = 300

type Params = { params: Promise<{ id: string }> }

const claimForCompletion = (
  worksheetId: string,
  status: 'queued' | 'awaiting_review',
  tierUsed: 'trial' | 'free' | 'cloud' | 'ollama',
) => claimWorksheetForCompletion(db, worksheetId, status, tierUsed)

/** Where a worksheet that was already completed should send the student. */
async function alreadyCompleted(worksheetId: string) {
  const [current] = await db
    .select({ status: worksheets.status, tierUsed: worksheets.tierUsed })
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  const queued = current?.status === 'queued' || current?.status === 'processing'

  return NextResponse.json({
    ok: true,
    tier: current?.tierUsed ?? null,
    mode: queued ? 'queued' : 'manual',
    // Said plainly rather than silently, so a caller that retried can tell the
    // difference between its work being done and being done twice.
    alreadyCompleted: true,
    next: queued
      ? `/worksheets/${worksheetId}/status`
      : `/worksheets/${worksheetId}/edit`,
  })
}

export async function POST(_request: Request, { params }: Params) {
  const { id: worksheetId } = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({ error: 'Not found' }, { status: guard.status })
  }


  const { tier, executor } = await resolveProvider(db, guard.userId)

  if (executor === 'none') {
    if (!(await claimForCompletion(worksheetId, 'awaiting_review', tier))) {
      return alreadyCompleted(worksheetId)
    }

    return NextResponse.json({
      ok: true,
      tier,
      mode: 'manual',
      next: `/worksheets/${worksheetId}/edit`,
    })
  }

  if (executor === 'operator_gpu') {
    // Before the claim and before the charge, so a refusal costs the student
    // neither a trial credit nor their worksheet's status. spec.md:583 caps
    // this at one, and nothing enforced it: the enqueue endpoint would take as
    // many worksheets as a script could post, and one account could hold the
    // whole queue against everyone else.
    //
    // Falls through to the manual editor rather than erroring, which is what
    // the exhausted-trial branch below already does. The student gets a working
    // screen and a reason, instead of a worksheet stuck mid-upload.
    if (
      guard.role !== 'admin' &&
      (await inFlightExtractCount(db, guard.userId)) >= MAX_IN_FLIGHT_EXTRACTS
    ) {
      if (!(await claimForCompletion(worksheetId, 'awaiting_review', 'free'))) {
        return alreadyCompleted(worksheetId)
      }

      return NextResponse.json({
        ok: true,
        tier: 'free',
        mode: 'manual',
        message:
          'Another worksheet of yours is still being read. This one was not counted ' +
          'against your trial: add its questions here, or come back once the first finishes.',
        next: `/worksheets/${worksheetId}/edit`,
      })
    }

    // Claimed before the trial is charged, so a losing request cannot spend
    // one. If the charge then fails, the status is put back below.
    if (!(await claimForCompletion(worksheetId, 'queued', 'trial'))) {
      return alreadyCompleted(worksheetId)
    }

    const charge =
      guard.role === 'admin'
        ? ({ ok: true, remaining: Number.POSITIVE_INFINITY } as const)
        : await consumeTrial(db, guard.userId, 'worksheets', 1)

    if (!charge.ok) {
      // Only the claim above could have put it in `queued`, so that is the
      // one state this fallback is allowed to move it out of.
      await transitionWorksheet(db, worksheetId, ['queued'], {
        status: 'awaiting_review',
        tierUsed: 'free',
      })

      return NextResponse.json({
        ok: true,
        tier: 'free',
        mode: 'manual',
        message: charge.reason,
        next: `/worksheets/${worksheetId}/edit`,
      })
    }

    await enqueueJob(db, {
      worksheetId,
      userId: guard.userId,
      stage: 'extract',
      executor: 'operator_gpu',

      priority: guard.role === 'admin' ? 'low' : 'normal',
    })

    const worker = await workerStatus(db)

    return NextResponse.json({
      ok: true,
      tier: 'trial',
      mode: 'queued',
      workerOnline: worker.online,
      trialWorksheetsRemaining: Number.isFinite(charge.remaining)
        ? charge.remaining
        : null,
      next: `/worksheets/${worksheetId}/status`,
    })
  }

  /*
   * Tier C. Queued like the trial, but for a worker that is the student's own
   * browser rather than the operator's GPU.
   *
   * No charge: the whole point of this tier is that the hardware is theirs, so
   * there is no cost of ours to meter. And no `after()` drain, because unlike
   * Tier B there is nothing here that can run it: `localhost:11434` is
   * reachable from the tab and from nowhere else (spec.md:184).
   */
  if (executor === 'browser') {
    if (!(await claimForCompletion(worksheetId, 'queued', tier))) {
      return alreadyCompleted(worksheetId)
    }

    await enqueueJob(db, {
      worksheetId,
      userId: guard.userId,
      stage: 'extract',
      executor: 'browser',
      priority: guard.role === 'admin' ? 'low' : 'normal',
    })

    return NextResponse.json({
      ok: true,
      tier,
      mode: 'browser',
      next: `/worksheets/${worksheetId}/status`,
    })
  }

  if (!(await claimForCompletion(worksheetId, 'queued', tier))) {
    return alreadyCompleted(worksheetId)
  }

  await enqueueJob(db, {
    worksheetId,
    userId: guard.userId,
    stage: 'extract',
    executor: 'server',
    priority: guard.role === 'admin' ? 'low' : 'normal',
  })

  // Runs once this response has gone out. There is no separate worker process
  // for Tier B to poll from. The extraction runs against the student's own
  // key, reachable directly from here, so this request is what starts it.
  // `.catch` is not optional here. `after` takes the promise and nothing else
  // awaits it, so a rejection out of the drain was an unhandled rejection in
  // the serverless runtime: the log said nothing and the queue stopped.
  after(() =>
    drainServerQueue(db).catch((error: unknown) => {
      console.error('[server-job] drain failed:', (error as Error).message)
    }),
  )

  return NextResponse.json({
    ok: true,
    tier,
    mode: 'queued',
    next: `/worksheets/${worksheetId}/status`,
  })
}
