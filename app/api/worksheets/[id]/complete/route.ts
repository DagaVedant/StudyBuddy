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

export async function POST(_request: Request, { params }: Params) {
  const { id: worksheetId } = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({ error: 'Not found' }, { status: guard.status })
  }

  const client = db as unknown as Db

  const { tier, executor } = await resolveProvider(client, guard.userId)

  if (executor === 'none') {
    await db
      .update(worksheets)
      .set({ status: 'awaiting_review', tierUsed: tier })
      .where(eq(worksheets.id, worksheetId))

    return NextResponse.json({
      ok: true,
      tier,
      mode: 'manual',
      next: `/worksheets/${worksheetId}/review`,
    })
  }

  if (executor === 'operator_gpu') {

    const charge =
      guard.role === 'admin'
        ? ({ ok: true, remaining: Number.POSITIVE_INFINITY } as const)
        : await consumeTrial(client, guard.userId, 'worksheets', 1)

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

    await db
      .update(worksheets)
      .set({ status: 'queued', tierUsed: 'trial' })
      .where(eq(worksheets.id, worksheetId))

    await enqueueJob(client, {
      worksheetId,
      userId: guard.userId,
      stage: 'extract',
      executor: 'operator_gpu',

      priority: guard.role === 'admin' ? 'low' : 'normal',
    })

    const worker = await workerStatus(client)

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
