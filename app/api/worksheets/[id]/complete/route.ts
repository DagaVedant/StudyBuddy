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
import { claimWorksheetForCompletion } from '@/lib/upload/claim'
import { guardWorksheet } from '@/lib/upload/guard'
import { drainServerQueue } from '@/lib/worker/server-job'

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
      : `/worksheets/${worksheetId}/review`,
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
      next: `/worksheets/${worksheetId}/review`,
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
        next: `/worksheets/${worksheetId}/review`,
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

      await db
        .update(worksheets)
        .set({ status: 'awaiting_review', tierUsed: 'free' })
        .where(eq(worksheets.id, worksheetId))

      return NextResponse.json({
        ok: true,
        tier: 'free',
        mode: 'manual',
        message: charge.reason,
        next: `/worksheets/${worksheetId}/review`,
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
  after(() => drainServerQueue(db))

  return NextResponse.json({
    ok: true,
    tier,
    mode: 'queued',
    next: `/worksheets/${worksheetId}/status`,
  })
}
