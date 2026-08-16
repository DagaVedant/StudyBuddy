import { and, desc, eq } from 'drizzle-orm'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { attempts, processingJobs, questions, worksheets } from '@/lib/db/schema'
import { queueDepth, workerStatus } from '@/lib/queue'
import { phaseFor } from '@/lib/worker/progress'
import { destination } from '@/lib/worksheets/destination'

import BrowserRunner from './browser-runner'
import GoManualButton from './go-manual-button'

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

  // `found` is read below to report progress, and by `destination` to tell an
  // extracted worksheet from one a student is typing in by hand. Alongside the
  // worksheet rather than after it: the destination is needed before anything
  // renders, so sequencing these would put a round trip in front of a redirect.
  const [[worksheet], found, markup] = await Promise.all([
    db.select().from(worksheets).where(eq(worksheets.id, id)).limit(1),
    db
      .select({ id: questions.id })
      .from(questions)
      .where(eq(questions.worksheetId, id)),
    // What the two list screens compute as `markedCount`, asked as an
    // existence check, since `destination` only compares it against zero.
    db
      .select({ id: attempts.id })
      .from(attempts)
      .innerJoin(questions, eq(attempts.questionId, questions.id))
      .where(and(eq(questions.worksheetId, id), eq(attempts.source, 'markup')))
      .limit(1),
  ])

  if (!worksheet || worksheet.userId !== session.user.id) notFound()

  // One answer per state, rather than this page's own. It used to send both
  // `awaiting_review` and `ready` to `/worksheets/[id]/review`, while a card
  // for that same worksheet on the dashboard or in the library asked
  // `destination` and got `/verify` or `/markup`. So the screen a student saw
  // depended on whether they had arrived from their own upload or from a card,
  // which is the one thing `destination` exists to prevent.
  //
  // Compared rather than listed: the states that belong on this page resolve
  // back to this same path, so this keeps agreeing with `destination` if it
  // ever changes its mind about which those are.
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

  // The count is a running total during reading, so it can pass what the
  // student told us the paper holds: a misread number, or the same question
  // picked up twice. Showing "115 of 114" reads as a bug, and the number is
  // not the useful thing at that point anyway: what matters is that the audit
  // is now going back over it. So once we are at or past the stated total, the
  // stage replaces the tally.
  const expected = worksheet.expectedQuestionCount
  const countIsTrustworthy = !expected || found.length < expected
  const stillReading = phase === 'reading' && countIsTrustworthy

  // Tier B (`executor === 'server'`) needs no physical worker at all, and
  // Tier C's worker is the tab this is rendering in, so neither is ever
  // "offline" in the sense this page means; only a Tier 0 job stuck behind an
  // operator GPU that has not sent a heartbeat is.
  const runsHere = job?.executor === 'browser'
  const isOnline = job?.executor === 'server' || runsHere || worker.online

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
            className="mt-6 h-1.5 overflow-hidden rounded bg-border"
          >
            <div
              className="h-full bg-accent transition-[width] duration-500"
              style={{ width: `${Math.max(percent, 4)}%` }}
            />
          </div>

          {/*
            Tier C reports its own progress, from the tab doing the work, so
            the server-rendered line below would be a second and staler answer
            to the same question. `BrowserRunner` is also the only thing that
            knows which page is being read right now; this page would find out
            a minute later, on the next revalidate.
          */}
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

              {/*
                Deliberately not shown for Tier C, where it would be the exact
                opposite of the truth: that tier's worker is this tab, so
                closing it stops the reading rather than leaving it running
                somewhere. BrowserRunner says so in its own words instead.
              */}
              <p className="hint">
                This page updates itself every minute. Safe to close: nothing is
                lost.
              </p>
            </>
          )}

          {/*
            spec.md:374's manual fallback used to exist only after a hard
            failure, which a worksheet queued against an offline worker never
            reaches on its own: it just waits, for as long as the operator's
            machine is down. This is the same escape, offered from the state a
            student actually gets stuck in.
          */}
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
