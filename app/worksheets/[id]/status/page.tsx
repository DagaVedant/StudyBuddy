import { desc, eq } from 'drizzle-orm'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { processingJobs, questions, worksheets } from '@/lib/db/schema'
import { queueDepth, workerStatus } from '@/lib/queue'
import { phaseFor } from '@/lib/worker/progress'

export const metadata = { title: 'Processing · StudyBuddy' }

export const revalidate = 0

export default async function StatusPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const session = await auth()
  if (!session?.user?.id) redirect('/signin')

  const [worksheet] = await db
    .select()
    .from(worksheets)
    .where(eq(worksheets.id, id))
    .limit(1)

  if (!worksheet || worksheet.userId !== session.user.id) notFound()

  if (worksheet.status === 'awaiting_review' || worksheet.status === 'ready') {
    redirect(`/worksheets/${id}/review`)
  }


  const [job] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.worksheetId, id))
    .orderBy(desc(processingJobs.createdAt))
    .limit(1)

  const [worker, depth, found] = await Promise.all([
    workerStatus(db),
    queueDepth(db, job?.executor ?? 'operator_gpu'),
    db
      .select({ id: questions.id })
      .from(questions)
      .where(eq(questions.worksheetId, id)),
  ])

  const failed = worksheet.status === 'failed' || job?.status === 'failed'
  const progress = job?.progress ?? 0
  const percent = Math.round(progress * 100)
  const phase = phaseFor(progress)

  // The count is a running total during reading, so it can pass what the
  // student told us the paper holds: a misread number, or the same question
  // picked up twice. Showing "115 of 114" reads as a bug, and the number is
  // not the useful thing at that point anyway: what matters is that the audit
  // is now going back over it. So once we are at or past the stated total, the
  // stage replaces the tally.
  const expected = worksheet.expectedQuestionCount
  const countIsTrustworthy = !expected || found.length < expected
  const stillReading = phase === 'reading' && countIsTrustworthy

  return (
    <main className="mx-auto w-full max-w-xl px-6 py-16">
      <h1 className="text-balance text-2xl font-semibold tracking-tight">
        {failed ? 'Something Went Wrong' : 'Working on It'}
      </h1>

      <p className="hint text-pretty">{worksheet.title}</p>

      {failed ? (
        <>
          <p className="mt-6 rounded-xl border border-danger/40 px-3 py-2 text-sm text-danger">
            {job?.error ?? 'Processing failed.'} This worksheet was not counted
            against your trial.
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Link
              href={`/worksheets/${id}/review`}
              className="btn btn-primary sm:w-auto sm:px-6"
            >
              Add Questions Manually
            </Link>
            <Link href="/dashboard" className="btn btn-secondary sm:w-auto sm:px-6">
              Back to Dashboard
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
            className="mt-6 h-1.5 overflow-hidden rounded bg-border"
          >
            <div
              className="h-full bg-accent motion-safe:transition-[width] motion-safe:duration-500"
              style={{ width: `${Math.max(percent, 4)}%` }}
            />
          </div>

          <p aria-live="polite" className="hint text-pretty">
            {job?.executor === 'server' || worker.online
              ? stillReading
                ? `Reading your worksheet. ${found.length} questions found so far.`
                : phase === 'classifying'
                  ? 'Sorting the questions into topics.'
                  : 'Checking every question was picked up, and going back over anything that was missed.'
              : 'Queued. The processing machine is offline right now, so this will start when it comes back. Safe to close this page; the worksheet will be waiting on your dashboard.'}
            {depth.pending > 1 && ` ${depth.pending} worksheets ahead of yours.`}
          </p>

          <p className="hint">
            This page updates itself every minute. Safe to close: nothing is
            lost.
          </p>

          <div className="mt-6">
            <Link href="/dashboard" className="btn btn-secondary sm:w-auto sm:px-6">
              Back to Dashboard
            </Link>
          </div>
        </>
      )}
    </main>
  )
}
