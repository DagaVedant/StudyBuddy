import { revalidatePath } from 'next/cache'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import AdminNav from '@/components/admin-nav'
import { db } from '@/lib/db'
import { cancelJob, listActionableJobs, requeueJob } from '@/lib/queue'
import { applyPermanentFailure } from '@/lib/worker/fail'

export const metadata = { title: 'Queue · StudyBuddy' }

const WHEN = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' })

const STAGE_LABEL: Record<string, string> = {
  extract: 'Extract',
  answer_key: 'Answer key',
  explain: 'Explain',
  classify: 'Classify',
}

export default async function AdminQueuePage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/signin')
  if (session.user.role !== 'admin') notFound()

  const jobs = await listActionableJobs(db)

  async function act(formData: FormData) {
    'use server'

    const current = await auth()
    if (current?.user?.role !== 'admin') return

    const jobId = String(formData.get('jobId'))
    const action = String(formData.get('action'))

    if (action === 'cancel') {
      const cancelled = await cancelJob(db, jobId)
      if (cancelled) {
        // Same accounting a job that failed on its own gets: refund the
        // trial credit if one was spent, fail the worksheet for a stage
        // that owns one. Reused rather than duplicated so an admin cancel
        // and a real failure cannot drift apart.
        await applyPermanentFailure(db, cancelled)
      } else {
        console.warn(`[admin] could not cancel job ${jobId}: already finished`)
      }
    } else if (action === 'requeue') {
      if (!(await requeueJob(db, jobId))) {
        console.warn(`[admin] could not requeue job ${jobId}: not failed or cancelled`)
      }
    }

    revalidatePath('/admin/queue')
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <h1 className="text-balance text-2xl font-semibold tracking-tight">Queue</h1>
      <p className="hint mb-6">
        Signed in as {session.user.email}. <AdminNav current="/admin/queue" />
      </p>

      <section aria-labelledby="jobs-heading">
        <h2 id="jobs-heading" className="text-sm font-medium">
          Stuck and failed jobs ({jobs.length})
        </h2>
        <p className="hint mb-3 text-pretty">
          Claimed or running jobs old enough to be suspect, plus anything
          already failed or cancelled. A healthy pending queue is not shown
          here; GPU heartbeat and queue depth are on{' '}
          <Link href="/admin/topics" className="underline underline-offset-2">
            Topic proposals
          </Link>
          .
        </p>

        {jobs.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border px-3 py-8 text-center text-sm text-muted">
            Nothing needs attention.
          </p>
        ) : (
          <ul className="card divide-y divide-border overflow-hidden">
            {jobs.map((job) => (
              <li key={job.id} className="p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {STAGE_LABEL[job.stage] ?? job.stage}
                      <span className="ml-2 text-xs uppercase tracking-wide text-muted">
                        {job.status}
                      </span>
                    </p>
                    <p className="text-xs text-muted">
                      {job.userEmail ?? job.userId} · {job.executor} · attempt{' '}
                      {job.attemptCount} · {WHEN.format(job.createdAt)}
                      {job.claimedAt && ` · claimed ${WHEN.format(job.claimedAt)}`}
                    </p>
                    {job.error && (
                      <p className="mt-1 line-clamp-2 text-sm text-danger">{job.error}</p>
                    )}
                  </div>

                  <div className="flex shrink-0 gap-2">
                    {(job.status === 'failed' || job.status === 'cancelled') && (
                      <form action={act}>
                        <input type="hidden" name="jobId" value={job.id} />
                        <input type="hidden" name="action" value="requeue" />
                        <button
                          type="submit"
                          className="rounded-xl border border-border px-2 py-1 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                        >
                          Requeue
                        </button>
                      </form>
                    )}
                    {(job.status === 'claimed' || job.status === 'running') && (
                      <form action={act}>
                        <input type="hidden" name="jobId" value={job.id} />
                        <input type="hidden" name="action" value="cancel" />
                        <button
                          type="submit"
                          className="rounded-xl border border-border px-2 py-1 text-sm text-muted hover:border-danger hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                        >
                          Cancel
                        </button>
                      </form>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
