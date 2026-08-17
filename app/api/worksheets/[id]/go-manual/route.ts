import { and, eq, inArray } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { processingJobs } from '@/lib/db/schema'
import { WORKSHEET_WRITE_LIMIT, guardRateLimit } from '@/lib/rate-limit'
import { guardWorksheet } from '@/lib/upload/guard'
import { claimWorksheetForManualFallback } from '@/lib/upload/claim'
import { applyPermanentFailure } from '@/lib/worker/fail'

type Params = { params: Promise<{ id: string }> }

export async function POST(_request: Request, { params }: Params) {
  const { id: worksheetId } = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({ error: 'Not found' }, { status: guard.status })
  }

  const limited = await guardRateLimit(
    db,
    WORKSHEET_WRITE_LIMIT,
    `user:${guard.userId}`,
    'Too many changes to your worksheets. Try again shortly.',
  )
  if (limited) return limited

  const won = await claimWorksheetForManualFallback(db, worksheetId)
  if (!won) {
    return NextResponse.json({ ok: true, next: `/worksheets/${worksheetId}/edit` })
  }

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

  await applyPermanentFailure(db, {
    stage: openJobs.find((job) => job.stage === 'extract')?.stage ?? 'extract',
    userId: guard.userId,
    worksheetId,
  })

  return NextResponse.json({ ok: true, next: `/worksheets/${worksheetId}/edit` })
}
