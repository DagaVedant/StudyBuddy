import { desc, eq, sql } from 'drizzle-orm'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { attempts, questions, worksheetPages, worksheets } from '@/lib/db/schema'

import DeleteWorksheetButton from './delete-worksheet-button'

export const metadata = { title: 'Worksheets · StudyBuddy' }
export const dynamic = 'force-dynamic'

const WHEN = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

function destination(id: string, status: string): { href: string; cta: string } {
  switch (status) {
    case 'uploading':
    case 'queued':
    case 'processing':
      return { href: `/worksheets/${id}/status`, cta: 'Processing' }
    case 'awaiting_review':
      return { href: `/worksheets/${id}/review`, cta: 'Check questions' }
    case 'failed':
      return { href: `/worksheets/${id}/status`, cta: 'See what happened' }
    default:
      return { href: `/worksheets/${id}/markup`, cta: 'Mark answers' }
  }
}

const STATUS_STYLE: Record<string, string> = {
  ready: 'text-success',
  awaiting_review: 'text-accent',
  failed: 'text-danger',
}

const STATUS_LABEL: Record<string, string> = {
  uploading: 'Uploading',
  queued: 'Queued',
  processing: 'Reading',
  awaiting_review: 'Needs review',
  ready: 'Done',
  failed: 'Failed',
}

export default async function WorksheetsPage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/signin')

  const rows = await db
    .select({
      id: worksheets.id,
      title: worksheets.title,
      status: worksheets.status,
      pageCount: worksheets.pageCount,
      sourceType: worksheets.sourceType,
      createdAt: worksheets.createdAt,
      questionCount: sql<number>`count(distinct ${questions.id})::int`,
      missedCount: sql<number>`count(distinct ${attempts.id}) filter (where ${attempts.outcome} = 'wrong')::int`,
      firstPageKey: sql<string | null>`min(${worksheetPages.imageKey})`,
    })
    .from(worksheets)
    .leftJoin(questions, eq(questions.worksheetId, worksheets.id))
    .leftJoin(attempts, eq(attempts.questionId, questions.id))
    .leftJoin(worksheetPages, eq(worksheetPages.worksheetId, worksheets.id))
    .where(eq(worksheets.userId, session.user.id))
    .groupBy(
      worksheets.id,
      worksheets.title,
      worksheets.status,
      worksheets.pageCount,
      worksheets.sourceType,
      worksheets.createdAt,
    )
    .orderBy(desc(worksheets.createdAt))

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-balance text-2xl font-semibold tracking-tight">
          Your Worksheets
        </h1>
        <Link href="/upload" className="btn btn-primary sm:w-auto sm:px-4">
          Upload a Worksheet
        </Link>
      </div>
      <p className="hint mb-6 text-pretty">
        Every file you have uploaded, with the pages we read from it.
      </p>

      {rows.length === 0 ? (
        <p className="rounded border border-dashed border-border px-4 py-12 text-center text-sm text-muted">
          Nothing uploaded yet. Your worksheets will appear here once you add one.
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((sheet) => {
            const { href, cta } = destination(sheet.id, sheet.status)

            return (
              <li
                key={sheet.id}
                className="flex flex-col overflow-hidden rounded border border-border bg-surface"
              >
                <Link
                  href={href}
                  className="block focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <div className="aspect-4/3 overflow-hidden border-b border-border bg-bg">
                    {sheet.firstPageKey ? (

                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={`/api/files/${sheet.firstPageKey}`}
                        alt={`First page of ${sheet.title}`}
                        loading="lazy"
                        className="size-full object-cover object-top"
                      />
                    ) : (
                      <div className="grid size-full place-items-center text-sm text-muted">
                        No pages
                      </div>
                    )}
                  </div>
                </Link>

                <div className="flex flex-1 flex-col p-3">
                  <Link
                    href={href}
                    className="line-clamp-2 font-medium hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    {sheet.title}
                  </Link>

                  <p className="hint tabular-nums">
                    {WHEN.format(sheet.createdAt)} · {sheet.pageCount}{' '}
                    {sheet.pageCount === 1 ? 'page' : 'pages'}
                  </p>

                  <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                    <div className="flex gap-1.5">
                      <dt className="text-muted">Questions</dt>
                      <dd className="font-medium tabular-nums">{sheet.questionCount}</dd>
                    </div>
                    {sheet.missedCount > 0 && (
                      <div className="flex gap-1.5">
                        <dt className="text-muted">Missed</dt>
                        <dd className="font-medium tabular-nums text-danger">
                          {sheet.missedCount}
                        </dd>
                      </div>
                    )}
                  </dl>

                  <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
                    <span
                      className={`text-xs font-medium ${STATUS_STYLE[sheet.status] ?? 'text-muted'}`}
                    >
                      {STATUS_LABEL[sheet.status] ?? sheet.status}
                    </span>
                    <div className="flex items-center gap-3">
                      <Link
                        href={href}
                        className="text-sm text-accent underline underline-offset-2"
                      >
                        {cta}
                      </Link>
                      <DeleteWorksheetButton worksheetId={sheet.id} title={sheet.title} />
                    </div>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </main>
  )
}
