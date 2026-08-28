import {and, desc, eq} from 'drizzle-orm'
import Link from 'next/link'
import {notFound, redirect} from 'next/navigation'

import {auth} from '@/auth'
import {db} from '@/lib/db'
import {attempts, processingJobs, questions, worksheets} from '@/lib/schema'
import {queueDepth, workerStatus} from '@/lib/queue'
import {phaseFor} from '@/lib/worker/apply'
import {destination, findSample} from '@/lib/upload'

import {BrowserRunner, GoManualButton, SampleRunner} from './status-client'

export const metadata = {title: 'Processing · StudyBuddy'}

export const revalidate = 0

export default async function StatusPage({
  params,
  searchParams,
}: {
  params: Promise<{id: string}>
  searchParams: Promise<{sample?: string}>
}) {
  const {id} = await params
  const sample = findSample((await searchParams).sample)

  const session = await auth()
  if (!session || !session.user || !session.user.id) redirect('/signin')

  const [[worksheet], found, markup] = await Promise.all([
    db.select().from(worksheets).where(eq(worksheets.id, id)).limit(1),
    db
      .select({id: questions.id})
      .from(questions)
      .where(eq(questions.worksheetId, id)),
    db
      .select({id: attempts.id})
      .from(attempts)
      .innerJoin(questions, eq(attempts.questionId, questions.id))
      .where(and(eq(questions.worksheetId, id), eq(attempts.source, 'markup')))
      .limit(1),
  ])

  if (!worksheet || worksheet.userId !== session.user.id) notFound()

  if (sample && worksheet.status === 'awaiting_review' && found.length > 0) {
    return (
      <main className="mx-auto w-full max-w-xl px-6 py-16">
        <h1 className="text-balance text-2xl font-semibold tracking-tight">
          Working on it
        </h1>

        <p className="hint text-pretty">{worksheet.title}</p>

        <SampleRunner
          worksheetId={id}
          questionCount={found.length}
          holdMs={sample.seconds * 1000}
        />
      </main>
    )
  }

  const target = destination(id, {
    status: worksheet.status,
    questionCount: found.length,
    markedCount: markup.length,
  })
  if (target.href !== '/worksheets/' + id + '/status') redirect(target.href)

  const [job] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.worksheetId, id))
    .orderBy(desc(processingJobs.createdAt))
    .limit(1)

  let executor: 'server' | 'browser' | 'operator_gpu' = 'operator_gpu'
  if (job) executor = job.executor

  const [worker, depth] = await Promise.all([
    workerStatus(db),
    queueDepth(db, executor),
  ])

  let failed = worksheet.status === 'failed'
  let progress = 0
  let jobError = 'Processing failed.'

  if (job) {
    if (job.status === 'failed') failed = true
    progress = job.progress
    if (job.error) jobError = job.error
  }

  const percent = Math.round(progress * 100)

  let barWidth = percent
  if (barWidth < 4) barWidth = 4
  const phase = phaseFor(progress)

  const expected = worksheet.expectedQuestionCount
  const countIsTrustworthy = !expected || found.length < expected
  const stillReading = phase === 'reading' && countIsTrustworthy

  const runsHere = executor === 'browser'

  let isOnline = worker.online
  if (executor === 'server' || runsHere) isOnline = true

  const stalled = !job && worksheet.status === 'uploading'

  let progressNote: string

  if (stalled) {
    progressNote =
      'This upload did not finish, so nothing is reading it. Add its questions by hand, or upload it again.'
  } else if (!isOnline) {
    progressNote =
      'Queued. The processing machine is offline right now, so this will start when it comes back. Safe to close this page; the worksheet will be waiting on your dashboard.'
  } else if (stillReading) {
    let noun = 'questions'
    if (found.length === 1) noun = 'question'

    progressNote = 'Reading your worksheet. ' + found.length + ' ' + noun + ' found so far.'
  } else if (phase === 'classifying') {
    progressNote = 'Sorting the questions into topics.'
  } else {
    progressNote =
      'Checking every question was picked up, and going back over anything that was missed.'
  }

  return (
    <main className="mx-auto w-full max-w-xl px-6 py-16">
      <h1 className="text-balance text-2xl font-semibold tracking-tight">
        {failed ? 'Something went wrong' : 'Working on it'}
      </h1>

      <p className="hint text-pretty">{worksheet.title}</p>

      {failed ? (
        <>
          <p className="mt-6 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
            {jobError} This worksheet was not counted
            against your trial.
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Link
              href={'/worksheets/' + id + '/edit'}
              className="btn btn-primary sm:w-auto sm:px-6"
            >
              Add questions manually
            </Link>
            <Link href="/dashboard" className="btn btn-secondary sm:w-auto sm:px-6">
              Back to dashboard
            </Link>
          </div>
        </>
      ) : (
        <>
          <div
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Extraction progress"
            className="mt-6 h-1.5 overflow-hidden rounded bg-wash-strong"
          >
            <div
              className="h-full bg-accent"
              style={{width: barWidth + '%'}}
            />
          </div>

          {runsHere ? (
            <BrowserRunner worksheetId={id} />
          ) : (
            <>
              <p aria-live="polite" className="hint text-pretty">
                {progressNote}
                {depth.pending > 1 && ' ' + depth.pending + ' worksheets ahead of yours.'}
              </p>

              <p className="hint text-pretty">
                This page updates itself every minute. Safe to close: the
                worksheet keeps going, and it will be on your dashboard when it
                is done.
              </p>
            </>
          )}

          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            {(!isOnline || stalled) && <GoManualButton worksheetId={id} />}
            <Link href="/dashboard" className="btn btn-secondary sm:w-auto sm:px-6">
              Back to dashboard
            </Link>
          </div>
        </>
      )}
    </main>
  )
}
