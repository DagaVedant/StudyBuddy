import { desc, eq, isNull } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import AdminNav from '@/components/admin-nav'
import { db } from '@/lib/db'
import { questions, reports, users, worksheets } from '@/lib/db/schema'

export const metadata = { title: 'Reports · StudyBuddy' }

const WHEN = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

export default async function AdminReportsPage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/signin')
  if (session.user.role !== 'admin') notFound()

  const open = await db
    .select({
      id: reports.id,
      kind: reports.kind,
      message: reports.message,
      createdAt: reports.createdAt,
      worksheetId: reports.worksheetId,
      worksheetTitle: worksheets.title,
      questionId: reports.questionId,
      promptText: questions.promptText,
      reporterEmail: users.email,
    })
    .from(reports)
    .innerJoin(users, eq(users.id, reports.userId))
    .leftJoin(worksheets, eq(worksheets.id, reports.worksheetId))
    .leftJoin(questions, eq(questions.id, reports.questionId))
    .where(isNull(reports.resolvedAt))
    .orderBy(desc(reports.createdAt))
    .limit(200)

  async function resolveReport(formData: FormData) {
    'use server'

    const current = await auth()
    if (current?.user?.role !== 'admin') return

    await db
      .update(reports)
      .set({ resolvedAt: new Date() })
      .where(eq(reports.id, String(formData.get('id'))))

    revalidatePath('/admin/reports')
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <h1 className="text-balance text-2xl font-semibold tracking-tight">Reports</h1>
      <p className="hint mb-6 text-pretty">
        What students said was wrong, newest first. Marking one done hides it here
        and keeps the row. <AdminNav current="/admin/reports" />
      </p>

      {open.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border px-3 py-8 text-center text-sm text-muted">
          Nothing reported.
        </p>
      ) : (
        <ul className="card divide-y divide-border overflow-hidden">
          {open.map((report) => (
            <li key={report.id} className="p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-xs uppercase tracking-wide text-muted">
                    {report.kind === 'worksheet' ? 'Whole worksheet' : 'Explanation'}
                    {' · '}
                    {WHEN.format(report.createdAt)}
                    {' · '}
                    {report.reporterEmail}
                  </p>

                  {report.worksheetId && (
                    <p className="mt-1 font-medium">
                      <Link
                        href={`/worksheets/${report.worksheetId}`}
                        className="underline underline-offset-2"
                      >
                        {report.worksheetTitle ?? 'Untitled worksheet'}
                      </Link>
                    </p>
                  )}

                  {report.promptText && (
                    <p className="mt-1 line-clamp-2 text-sm text-muted">
                      {report.promptText}
                    </p>
                  )}

                  {report.message ? (
                    <p className="mt-2 whitespace-pre-line text-pretty text-sm">
                      {report.message}
                    </p>
                  ) : (
                    <p className="mt-2 text-sm italic text-muted">No note left.</p>
                  )}
                </div>

                <form action={resolveReport} className="shrink-0">
                  <input type="hidden" name="id" value={report.id} />
                  <button
                    type="submit"
                    className="rounded-xl border border-border px-2 py-1 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    Done
                  </button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
