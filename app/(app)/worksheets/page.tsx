import { desc, eq, inArray, sql } from 'drizzle-orm'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { attempts, questions, worksheetPages, worksheets } from '@/lib/db/schema'
import { IS_QUESTION } from '@/lib/questions/is-question'
import { destination } from '@/lib/worksheets/destination'

import DeleteWorksheetButton from './delete-worksheet-button'

export const metadata = { title: 'Worksheets · StudyBuddy' }
export const dynamic = 'force-dynamic'

/**
 * How many worksheet cards this page renders.
 *
 * Matches the limit on `GET /api/worksheets`, which lists the same thing. The
 * page has no paging, so this is also the honest maximum rather than a
 * performance trick.
 */
const WORKSHEETS_SHOWN = 50

const WHEN = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

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
      // Counts questions, not everything stored: see `IS_QUESTION`. Both counts
      // below share it deliberately, and so does the dashboard now. Filtering
      // one and not the other put "Questions 25" beside "Unchecked 26" on the
      // same card, and filtering this page and not the dashboard put 25 and 26
      // on two screens describing the same paper.
      questionCount: sql<number>`count(distinct ${questions.id}) filter (where ${IS_QUESTION})::int`,
      uncheckedCount: sql<number>`(count(distinct ${questions.id}) filter (
        where ${questions.userVerified} = false and ${IS_QUESTION}))::int`,
      missedCount: sql<number>`count(distinct ${attempts.id}) filter (where ${attempts.outcome} = 'wrong')::int`,
      markedCount: sql<number>`count(distinct ${attempts.id}) filter (where ${attempts.source} = 'markup')::int`,
    })
    .from(worksheets)
    // `questions` and `attempts` are a chain: attempts hang off a question, so
    // this multiplies rows by attempts per question, which the `distinct`
    // counts above already handle.
    //
    // `worksheet_pages` used to be joined here too, and it is not part of that
    // chain: it hangs off the worksheet, so questions times pages was a
    // cartesian product. A 45 question, 7 page worksheet produced 315 rows and
    // ran the IS_QUESTION regex on every one of them, to compute a thumbnail
    // that needs one row. It is its own query below.
    .leftJoin(questions, eq(questions.worksheetId, worksheets.id))
    .leftJoin(attempts, eq(attempts.questionId, questions.id))
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
    // Bounded, like the API route that lists the same thing. This page renders
    // a card per worksheet with no paging, so an account with a thousand
    // worksheets was building a thousand cards nobody scrolls to.
    .limit(WORKSHEETS_SHOWN)

  // One row per worksheet, for the thumbnails, over only the worksheets that
  // are actually on screen.
  const thumbnails = rows.length
    ? await db
        .select({
          worksheetId: worksheetPages.worksheetId,
          imageKey: sql<string>`min(${worksheetPages.imageKey})`,
        })
        .from(worksheetPages)
        .where(
          inArray(
            worksheetPages.worksheetId,
            rows.map((row) => row.id),
          ),
        )
        .groupBy(worksheetPages.worksheetId)
    : []

  const thumbnailFor = new Map(thumbnails.map((row) => [row.worksheetId, row.imageKey]))

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-balance text-2xl font-semibold tracking-tight">
          Your Worksheets
        </h1>
        <Link href="/upload" className="btn btn-primary sm:w-auto sm:px-4">
          Upload a worksheet
        </Link>
      </div>
      <p className="hint mb-6 text-pretty">
        Every file you have uploaded, with the pages we read from it.
      </p>

      {rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border px-4 py-12 text-center text-sm text-muted">
          Nothing uploaded yet. Your worksheets will appear here once you add one.
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((sheet) => {
            const { href, cta } = destination(
              sheet.id,
              sheet.status,
              sheet.markedCount > 0,
            )

            return (
              <li
                key={sheet.id}
                className="card flex flex-col overflow-hidden"
              >
                <Link
                  href={href}
                  className="block focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <div className="aspect-4/3 overflow-hidden border-b border-border bg-bg">
                    {thumbnailFor.get(sheet.id) ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={`/api/files/${thumbnailFor.get(sheet.id)}`}
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
                    {sheet.uncheckedCount > 0 && sheet.questionCount > 0 && (
                      <div className="flex gap-1.5">
                        <dt className="text-muted">Unchecked</dt>
                        <dd className="font-medium tabular-nums">{sheet.uncheckedCount}</dd>
                      </div>
                    )}
                    {sheet.missedCount > 0 && (
                      <div className="flex gap-1.5">
                        <dt className="text-muted">Missed</dt>
                        <dd className="font-medium tabular-nums text-danger">
                          {sheet.missedCount}
                        </dd>
                      </div>
                    )}
                  </dl>

                  {sheet.missedCount > 0 && (
                    <a
                      href={`/api/export/blooket/${sheet.id}`}
                      download
                      className="mt-2 self-start text-sm text-accent underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      Export missed to Blooket
                    </a>
                  )}

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
