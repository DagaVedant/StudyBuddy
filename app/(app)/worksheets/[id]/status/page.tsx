import {and, desc, eq} from 'drizzle-orm'
import Link from 'next/link'
import {notFound, redirect} from 'next/navigation'

import {auth} from '@/auth'
import {db} from '@/lib/db'
import {attempts, processingJobs, questions, worksheets} from '@/lib/db/schema'
import {queueDepth, workerStatus} from '@/lib/queue'
import {phaseFor} from '@/lib/worker/apply'
import {destination} from '@/lib/upload'

import {BrowserRunner, GoManualButton} from './status-client'

export const metadata = {title: 'Processing · StudyBuddy'}

export const revalidate = 0

export default async function StatusPage({
  params,
}: {
  params: Promise<{id: string}>
}) {
  const {id} = await params

  const session = await auth()
  if (!session?.user?.id) redirect('/signin')

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

  const target = destination(id, {
    status: worksheet.status,
    questionCount: found.length,
    markedCount: markup.length,
  })
  if (target.href !== `/worksheets/${id}/status`) redirect(target.href)

  const [job] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.worksheetId, id))
    .orderBy(desc(processingJobs.createdAt))
    .limit(1)

  const [worker, depth] = await Promise.all([
    workerStatus(db),
    queueDepth(db, job?.executor ?? 'operator_gpu'),
  ])

  const failed = worksheet.status === 'failed' || job?.status === 'failed'
  const progress = job?.progress ?? 0
  const percent = Math.round(progress * 100)
  const phase = phaseFor(progress)

  const expected = worksheet.expectedQuestionCount
  const countIsTrustworthy = !expected || found.length < expected
  const stillReading = phase === 'reading' && countIsTrustworthy

  const runsHere = job?.executor === 'browser'
  const isOnline = job?.executor === 'server' || runsHere || worker.online

  return (
    <main className="mx-auto w-full max-w-xl px-6 py-16">
      <h1 className="text-balance text-2xl font-semibold tracking-tight">
        {failed ? 'Something went wrong' : 'Working on it'}
      </h1>

      <p className="hint text-pretty">{worksheet.title}</p>

      {failed ? (
        <>
          <p className="mt-6 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
            {job?.error ?? 'Processing failed.'} This worksheet was not counted
            against your trial.
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Link
              href={`/worksheets/${id}/edit`}
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
              className="h-full bg-accent transition-[width] duration-500"
              style={{width: `${Math.max(percent, 4)}%`}}
            />
          </div>

          {runsHere ? (
            <BrowserRunner worksheetId={id} />
          ) : (
            <>
              <p aria-live="polite" className="hint text-pretty">
                {isOnline
                  ? stillReading
                    ? `Reading your worksheet. ${found.length} ${found.length === 1 ? 'question' : 'questions'} found so far.`
                    : phase === 'classifying'
                      ? 'Sorting the questions into topics.'
                      : 'Checking every question was picked up, and going back over anything that was missed.'
                  : 'Queued. The processing machine is offline right now, so this will start when it comes back. Safe to close this page; the worksheet will be waiting on your dashboard.'}
                {depth.pending > 1 && ` ${depth.pending} worksheets ahead of yours.`}
              </p>

              <p className="hint text-pretty">
                This page updates itself every minute. Safe to close: we will
                tell you when it is done, and it will be waiting in the bell at
                the top of the screen.
              </p>
            </>
          )}

          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            {!isOnline && <GoManualButton worksheetId={id} />}
            <Link href="/dashboard" className="btn btn-secondary sm:w-auto sm:px-6">
              Back to dashboard
            </Link>
          </div>
        </>
      )}
    </main>
  )
}
