import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import AdminNav from '@/components/admin-nav'
import {
  TRIAL_EXPLANATION_LIMIT,
  TRIAL_WORKSHEET_LIMIT,
  USAGE_SUMMARY_WINDOW_DAYS,
  trialQuotaLeaders,
  usageSummary,
} from '@/lib/ai/usage-summary'
import { db } from '@/lib/db'

export const metadata = { title: 'Usage · StudyBuddy' }

const KIND_LABEL: Record<string, string> = {
  extract_page: 'Pages extracted',
  answer_derive: 'Answers derived',
  classify: 'Questions classified',
  explain: 'Explanations',
}

export default async function AdminUsagePage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/signin')
  if (session.user.role !== 'admin') notFound()

  const [summary, leaders] = await Promise.all([
    usageSummary(db),
    trialQuotaLeaders(db, 20),
  ])

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <h1 className="text-balance text-2xl font-semibold tracking-tight">Usage</h1>
      <p className="hint mb-6">
        Signed in as {session.user.email}. <AdminNav current="/admin/usage" />
      </p>

      <section aria-labelledby="summary-heading" className="card p-4">
        <h2 id="summary-heading" className="text-sm font-medium">
          Last {USAGE_SUMMARY_WINDOW_DAYS} days
        </h2>
        <p className="hint mb-3 text-pretty">
          Excludes anything later refunded, so a failed batch does not read as
          a spike in real usage.
        </p>

        {summary.length === 0 ? (
          <p className="rounded-2xl card-sunk px-3 py-8 text-center text-sm text-muted">
            Nothing recorded.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-1 pr-3 font-medium">Kind</th>
                  <th className="py-1 pr-3 font-medium">Tier</th>
                  <th className="py-1 pr-3 text-right font-medium">Events</th>
                  <th className="py-1 text-right font-medium">Quantity</th>
                </tr>
              </thead>
              <tbody>
                {summary.map((row) => (
                  <tr key={`${row.kind}-${row.tierUsed}`} className="/60">
                    <td className="py-1.5 pr-3">{KIND_LABEL[row.kind] ?? row.kind}</td>
                    <td className="py-1.5 pr-3 text-muted">{row.tierUsed ?? '—'}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{row.events}</td>
                    <td className="py-1.5 text-right tabular-nums">{row.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="quota-heading" className="mt-6">
        <h2 id="quota-heading" className="text-sm font-medium">
          Trial quota, most used first
        </h2>
        <p className="hint mb-3 text-pretty">
          Limits are {TRIAL_WORKSHEET_LIMIT} worksheets and{' '}
          {TRIAL_EXPLANATION_LIMIT} explanations per account, for the life of
          the account. Only questions and content are off limits to admins;
          usage counts are not.
        </p>

        {leaders.length === 0 ? (
          <p className="rounded-2xl card-sunk px-3 py-8 text-center text-sm text-muted">
            No trial usage yet.
          </p>
        ) : (
          <ul className="card overflow-hidden">
            {leaders.map((row) => (
              <li key={row.userId} className="flex items-center justify-between gap-3 p-3">
                <span className="min-w-0 truncate text-sm">{row.email}</span>
                <span className="shrink-0 text-sm tabular-nums text-muted">
                  {row.worksheetsUsed}/{TRIAL_WORKSHEET_LIMIT} worksheets ·{' '}
                  {row.explanationsUsed}/{TRIAL_EXPLANATION_LIMIT} explanations
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
