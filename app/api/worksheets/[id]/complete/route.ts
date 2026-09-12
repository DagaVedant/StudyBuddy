import {after, NextResponse} from 'next/server'
import {eq} from 'drizzle-orm'
import {worksheets} from '@/lib/schema'
import {claimWorksheetForCompletion, enqueueJob, guardWorksheet, inFlightExtractCount, MAX_IN_FLIGHT_EXTRACTS, transitionWorksheet} from '@/lib/queue'
import {guardRateLimit, WORKSHEET_WRITE_LIMIT} from '@/lib/api'
import {consumeTrial, resolveProvider, type Tier, trialExtractionsToday} from '@/lib/ai/resolve'
import {operatorUsage} from '@/lib/ai/usage'
import {trialDailyCeiling} from '@/lib/ai/types'
import {db} from '@/lib/db'
import {applyCachedSample, findMatchingSample} from '@/lib/samples'
import {drainServerQueue} from '@/lib/worker/jobs'

export const maxDuration = 300

const claimForCompletion = (
  worksheetId: string,
  status: 'queued' | 'awaiting_review',
  tierUsed: Tier,
) => claimWorksheetForCompletion(db, worksheetId, status, tierUsed)

async function alreadyCompleted(worksheetId: string) {
  const [current] = await db
    .select({status: worksheets.status, tierUsed: worksheets.tierUsed})
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  let queued = false
  let tier = null

  if (current) {
    if (current.status === 'queued' || current.status === 'processing') queued = true
    tier = current.tierUsed
  }

  let mode = 'manual'
  let next = '/worksheets/' + worksheetId + '/edit'

  if (queued) {
    mode = 'queued'
    next = '/worksheets/' + worksheetId + '/status'
  }

  return NextResponse.json({ok: true, tier, mode, alreadyCompleted: true, next})
}

async function postIdComplete(_request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const {id: worksheetId} = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({error: 'Not found'}, {status: guard.status})
  }

  const limited = await guardRateLimit(
    db,
    WORKSHEET_WRITE_LIMIT,
    'user:' + guard.userId,
    'Too many changes to your worksheets. Try again shortly.',
  )
  if (limited) return limited

  const match = await findMatchingSample(db, worksheetId)

  if (match) {
    if (!(await claimForCompletion(worksheetId, 'queued', 'free'))) {
      return alreadyCompleted(worksheetId)
    }

    let kept = 0

    try {
      kept = await applyCachedSample(
        db,
        worksheetId,
        guard.userId,
        match.sample,
        match.pages,
      )
    } catch (error) {
      // a claimed worksheet with no job would sit in the queue forever
      console.error(
        '[sample] ' + match.sample.slug + ' failed on ' + worksheetId + ':',
        (error as Error).message,
      )
    }

    await transitionWorksheet(db, worksheetId, ['queued'], {
      status: 'awaiting_review',
      tierUsed: 'free',
      sampleSlug: match.sample.slug,
    })

    return NextResponse.json({
      ok: true,
      tier: 'free',
      mode: 'sample',
      questionCount: kept,
      next: '/worksheets/' + worksheetId + '/status?sample=' + match.sample.slug,
    })
  }

  const {tier, executor} = await resolveProvider(db, guard.userId)

  if (executor === 'none') {
    if (!(await claimForCompletion(worksheetId, 'awaiting_review', tier))) {
      return alreadyCompleted(worksheetId)
    }

    let message =
      'Your free reads are used up. Nothing else changes: StudyBuddy stays free. ' +
      'Add this one\'s questions by hand, or connect your own AI provider in ' +
      'settings and upload it again.'

    if (tier === 'trial') {
      message =
        'Nothing is set up to read worksheets on this deployment right now, so this ' +
        'one was not counted against your trial. Add its questions by hand, or ' +
        'connect your own AI provider in settings and upload it again.'
    }

    return NextResponse.json({
      ok: true,
      tier,
      mode: 'manual',
      message: message,
      next: '/worksheets/' + worksheetId + '/edit',
    })
  }

  if (
    guard.role !== 'admin' &&
    tier === 'trial' &&
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
      next: '/worksheets/' + worksheetId + '/edit',
    })
  }

  if (guard.role !== 'admin' && tier === 'trial') {
    const usage = await operatorUsage(db)

    if (usage.level === 'exhausted') {
      if (!(await claimForCompletion(worksheetId, 'awaiting_review', 'free'))) {
        return alreadyCompleted(worksheetId)
      }

      return NextResponse.json({
        ok: true,
        tier: 'free',
        mode: 'manual',
        message:
          'The free model that reads worksheets is out of reads until midnight UTC, so ' +
          'this one was not counted against your trial. Add its questions here, or ' +
          'upload it again tomorrow.',
        next: '/worksheets/' + worksheetId + '/edit',
      })
    }

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
          'against yours. Add its questions here, or come back tomorrow.',
        next: '/worksheets/' + worksheetId + '/edit',
      })
    }
  }

  if (!(await claimForCompletion(worksheetId, 'queued', tier))) {
    return alreadyCompleted(worksheetId)
  }

  const charge =
    guard.role === 'admin' || tier !== 'trial'
      ? ({ok: true, remaining: Number.POSITIVE_INFINITY} as const)
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
      next: '/worksheets/' + worksheetId + '/edit',
    })
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
    trialWorksheetsRemaining: Number.isFinite(charge.remaining) ? charge.remaining : null,
    next: '/worksheets/' + worksheetId + '/status',
  })
}

export {postIdComplete as POST}
