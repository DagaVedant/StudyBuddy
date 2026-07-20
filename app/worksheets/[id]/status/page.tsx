import { desc, eq } from 'drizzle-orm'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import type { Db } from '@/lib/dashboard/queries'
import { db } from '@/lib/db'
import { processingJobs, questions, worksheets } from '@/lib/db/schema'
import { queueDepth, workerStatus } from '@/lib/queue'

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

  const client = db as unknown as Db

  const [job] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.worksheetId, id))
    .orderBy(desc(processingJobs.createdAt))
    .limit(1)

  const [worker, depth, found] = await Promise.all([
    workerStatus(client),
    queueDepth(client, job?.executor ?? 'operator_gpu'),
    db
      .select({ id: questions.id })
      .from(questions)
      .where(eq(questions.worksheetId, id)),
  ])

  const failed = worksheet.status === 'failed' || job?.status === 'failed'
  const percent = Math.round((job?.progress ?? 0) * 100)

  return (
    <main className="mx-auto w-full max-w-xl px-6 py-16">
      <h1 className="text-balance text-2xl font-semibold tracking-tight">
        {failed ? 'Something Went Wrong' : 'Working on It'}
      </h1>

      <p className="hint text-pretty">{worksheet.title}</p>

      {failed ? (
        <>
          <p className="mt-6 rounded border border-danger/40 px-3 py-2 text-sm text-danger">
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
            {worker.online
              ? `Reading your worksheet — ${found.length} questions found so far.`
              : 'Queued. The processing machine is offline right now, so this will start when it comes back. You can close this page; we will email you.'}
            {depth.pending > 1 && ` ${depth.pending} worksheets ahead of yours.`}
          </p>

          <p className="hint">
            This page updates on refresh. Safe to close — nothing is lost.
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
