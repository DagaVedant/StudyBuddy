import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { consumeTrial } from '@/lib/ai/quota'
import { resolveProvider } from '@/lib/ai/resolve'
import type { Db } from '@/lib/dashboard/queries'
import { db } from '@/lib/db'
import { worksheets } from '@/lib/db/schema'
import { enqueueJob, workerStatus } from '@/lib/queue'
import { guardWorksheet } from '@/lib/upload/guard'

type Params = { params: Promise<{ id: string }> }

/**
 * Ends the client-side ingest phase and routes the worksheet to whichever
 * processing path the account's tier implies (spec §4, §5.2 step 5).
 */
export async function POST(_request: Request, { params }: Params) {
  const { id: worksheetId } = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({ error: 'Not found' }, { status: guard.status })
  }

  const client = db as unknown as Db

  const [worksheet] = await db
    .select({ pageCount: worksheets.pageCount })
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  const pageCount = worksheet?.pageCount ?? 0
  const { tier, executor } = await resolveProvider(client, guard.userId)

  /* Tier A — no AI at all; straight to the manual editor. */
  if (executor === 'none' || executor === 'browser') {
    await db
      .update(worksheets)
      .set({ status: 'awaiting_review', tierUsed: tier })
      .where(eq(worksheets.id, worksheetId))

    return NextResponse.json({
      ok: true,
      tier,
      // Tier C drives extraction from the browser (spec §3.4).
      mode: executor === 'browser' ? 'client_ai' : 'manual',
      next: `/worksheets/${worksheetId}/review`,
    })
  }

  /* Tier 0 — operator GPU. Quota is charged here, server-side, at enqueue. */
  if (executor === 'operator_gpu') {
    const charge = await consumeTrial(client, guard.userId, 'pages', pageCount)

    if (!charge.ok) {
      // Out of trial: fall back to the manual editor rather than dead-ending.
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

    await db
      .update(worksheets)
      .set({ status: 'queued', tierUsed: 'trial' })
      .where(eq(worksheets.id, worksheetId))

    await enqueueJob(client, {
      worksheetId,
      userId: guard.userId,
      stage: 'extract',
      executor: 'operator_gpu',
      // Admin bulk uploads yield to trial users (spec §2.1).
      priority: guard.role === 'admin' ? 'low' : 'normal',
    })

    const worker = await workerStatus(client)

    return NextResponse.json({
      ok: true,
      tier: 'trial',
      mode: 'queued',
      workerOnline: worker.online,
      trialPagesRemaining: charge.remaining,
      next: `/worksheets/${worksheetId}/status`,
    })
  }

  /* Tier B — server-side job with the student's own key. */
  await db
    .update(worksheets)
    .set({ status: 'queued', tierUsed: tier })
    .where(eq(worksheets.id, worksheetId))

  await enqueueJob(client, {
    worksheetId,
    userId: guard.userId,
    stage: 'extract',
    executor: 'server',
    priority: guard.role === 'admin' ? 'low' : 'normal',
  })

  return NextResponse.json({
    ok: true,
    tier,
    mode: 'queued',
    next: `/worksheets/${worksheetId}/status`,
  })
}
