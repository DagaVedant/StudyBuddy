import { and, eq, inArray } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { processingJobs } from '@/lib/db/schema'
import { guardWorksheet } from '@/lib/upload/guard'
import { claimWorksheetForManualFallback } from '@/lib/upload/claim'
import { applyPermanentFailure } from '@/lib/worker/fail'

type Params = { params: Promise<{ id: string }> }

/**
 * The escape hatch a worksheet queued against an offline worker never had.
 *
 * It used to sit in `processing` for as long as the operator's GPU stayed
 * down, however long that was, with the status page offering exactly one
 * control: a link back to the dashboard. spec.md:374's manual fallback
 * existed only after a hard failure, unreachable from the state a student
 * actually gets stuck in.
 *
 * Moves the worksheet to `failed`, which is not a euphemism: from the
 * student's side, giving up on the wait and processing did not happen are the
 * same outcome, and `failed` is the status the status page and the dashboard
 * list already know how to render a manual-entry link for. No second branch
 * to keep in sync with the first.
 */
export async function POST(_request: Request, { params }: Params) {
  const { id: worksheetId } = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({ error: 'Not found' }, { status: guard.status })
  }

  // The atomic claim is the concurrency guard: only the caller that wins it
  // cancels the job and refunds the trial, so a double click cannot do either
  // twice. A caller that loses is not an error — the worksheet already left
  // the state this exists for, most likely because the worker claimed the job
  // in the moment between the page loading and the click landing.
  const won = await claimWorksheetForManualFallback(db, worksheetId)
  if (!won) {
    return NextResponse.json({ ok: true, next: `/worksheets/${worksheetId}/review` })
  }

  // Cancelled, not deleted or left pending. A pending row is exactly what the
  // worker's claim query looks for, and the worker coming back online must
  // not be allowed to extract into a worksheet the student has already
  // started filling in by hand: that is the double-entry this whole route
  // exists to prevent.
  const openJobs = await db
    .select({ id: processingJobs.id, stage: processingJobs.stage })
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.worksheetId, worksheetId),
        inArray(processingJobs.status, ['pending', 'claimed', 'running']),
      ),
    )

  for (const job of openJobs) {
    await db
      .update(processingJobs)
      .set({
        status: 'cancelled',
        error: 'The student chose to enter questions manually rather than wait.',
      })
      .where(eq(processingJobs.id, job.id))
  }

  // The same accounting a permanent extraction failure already uses: refund
  // the trial credit if one was spent, since the worker being offline is not
  // something the student did. Reused rather than duplicated so this route
  // cannot drift from what a real failure does.
  await applyPermanentFailure(db, {
    stage: openJobs.find((job) => job.stage === 'extract')?.stage ?? 'extract',
    userId: guard.userId,
    worksheetId,
  })

  return NextResponse.json({ ok: true, next: `/worksheets/${worksheetId}/review` })
}
