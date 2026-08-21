import { eq } from 'drizzle-orm'
import { after, NextResponse } from 'next/server'

import { trialDailyCeiling } from '@/lib/ai/types'
import { consumeTrial, trialExtractionsToday } from '@/lib/ai/resolve'
import { resolveProvider } from '@/lib/ai/resolve'
import { db } from '@/lib/db'
import { worksheets } from '@/lib/db/schema'
import {
  MAX_IN_FLIGHT_EXTRACTS,
  enqueueJob,
  inFlightExtractCount,
  workerStatus,
} from '@/lib/queue'
import { WORKSHEET_WRITE_LIMIT, guardRateLimit } from '@/lib/rate-limit'
import { claimWorksheetForCompletion, transitionWorksheet } from '@/lib/queue'
import { guardWorksheet } from '@/lib/queue'
import { drainServerQueue } from '@/lib/worker/server-job'

export const maxDuration = 300

type Params = { params: Promise<{ id: string }> }

const claimForCompletion = (
  worksheetId: string,
  status: 'queued' | 'awaiting_review',
  tierUsed: 'trial' | 'free' | 'cloud' | 'ollama',
) => claimWorksheetForCompletion(db, worksheetId, status, tierUsed)

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

  const limited = await guardRateLimit(
    db,
    WORKSHEET_WRITE_LIMIT,
    `user:${guard.userId}`,
    'Too many changes to your worksheets. Try again shortly.',
  )
  if (limited) return limited

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

    if (guard.role !== 'admin') {
      const ceiling = trialDailyCeiling()

      if ((await trialExtractionsToday(db)) >= ceiling) {
        if (!(await claimForCompletion(worksheetId, 'awaiting_review', 'free'))) {
          return alreadyCompleted(worksheetId)
        }

        return NextResponse.json({
          ok: true,
          tier: 'free',
          mode: 'manual',
          message:
            'The free trial has hit its limit for today, so this one was not counted ' +
            'against yours. Add its questions here, come back tomorrow, or connect ' +
            'your own AI in settings.',
          next: `/worksheets/${worksheetId}/edit`,
        })
      }
    }

    if (!(await claimForCompletion(worksheetId, 'queued', 'trial'))) {
      return alreadyCompleted(worksheetId)
    }

    const charge =
      guard.role === 'admin'
        ? ({ ok: true, remaining: Number.POSITIVE_INFINITY } as const)
        : await consumeTrial(db, guard.userId, 'worksheets', 1)

    if (!charge.ok) {
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
