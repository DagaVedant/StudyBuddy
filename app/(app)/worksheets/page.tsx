import { and, desc, eq, ilike, inArray, lt, sql } from 'drizzle-orm'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import PageHead from '@/components/page-head'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { attempts, questions, worksheetPages, worksheets } from '@/lib/db/schema'
import { IS_QUESTION } from '@/lib/questions/sql'
import { destination } from '@/lib/worksheets/destination'

import DeleteWorksheetButton from './delete-worksheet-button'
import WorksheetTitle from './worksheet-title'

export const metadata = { title: 'Worksheets · StudyBuddy' }
export const dynamic = 'force-dynamic'

const WORKSHEETS_SHOWN = 50

function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

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

export default async function WorksheetsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[]; before?: string | string[] }>
}) {
  const session = await auth()
  if (!session?.user?.id) redirect('/signin')

  const params = await searchParams
  const first = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value[0] : value

  const query = (first(params.q) ?? '').trim().slice(0, 100)

  const beforeRaw = first(params.before)
  const before = beforeRaw ? new Date(beforeRaw) : null
  const cursor = before && !Number.isNaN(before.getTime()) ? before : null

  const filters = [
    eq(worksheets.userId, session.user.id),
    eq(worksheets.origin, 'extracted'),
  ]
  if (query) filters.push(ilike(worksheets.title, `%${likeLiteral(query)}%`))
  if (cursor) filters.push(lt(worksheets.createdAt, cursor))

  const rows = await db
    .select({
      id: worksheets.id,
      title: worksheets.title,
      status: worksheets.status,
      pageCount: worksheets.pageCount,
      sourceType: worksheets.sourceType,
      createdAt: worksheets.createdAt,
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
    .where(and(...filters))
    .groupBy(
      worksheets.id,
      worksheets.title,
      worksheets.status,
      worksheets.pageCount,
      worksheets.sourceType,
      worksheets.createdAt,
    )
    .orderBy(desc(worksheets.createdAt))
    // One more than the page holds, purely to find out whether there is a next
    // page. Counting the whole table to answer that costs a second query over
    // every row, to render one link.
    .limit(WORKSHEETS_SHOWN + 1)

  const hasOlder = rows.length > WORKSHEETS_SHOWN
  if (hasOlder) rows.pop()

  const olderThan = rows.at(-1)?.createdAt

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
      <PageHead
        title="Your worksheets"
        lede="Every file you have uploaded, with the pages we read from it."
      >
        <Link href="/upload" className="btn btn-primary sm:w-auto sm:px-4">
          Upload a worksheet
        </Link>
      </PageHead>

      <form method="get" role="search" className="mb-6 mt-4 flex gap-2">
        <label className="sr-only" htmlFor="worksheet-search">
          Search your worksheets by title
        </label>
        <input
          id="worksheet-search"
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Search by title…"
          autoComplete="off"
          className="field sm:max-w-xs"
        />
        <button type="submit" className="btn btn-secondary sm:w-auto sm:px-4">
          Search
        </button>
        {query && (
          <Link href="/worksheets" className="btn btn-secondary sm:w-auto sm:px-4">
            Clear
          </Link>
        )}
      </form>

      {rows.length === 0 && query ? (
        <p className="rounded-2xl card-sunk px-4 py-12 text-center text-sm text-muted">
          Nothing matches “{query}”.{' '}
          <Link href="/worksheets" className="text-accent underline underline-offset-2">
            Show all worksheets
          </Link>
          .
        </p>
      ) : rows.length === 0 && cursor ? (
        <p className="rounded-2xl card-sunk px-4 py-12 text-center text-sm text-muted">
          Nothing older to show.{' '}
          <Link href="/worksheets" className="text-accent underline underline-offset-2">
            Back to the newest
          </Link>
          .
        </p>
      ) : rows.length === 0 ? (
        <p className="rounded-2xl card-sunk px-4 py-12 text-center text-sm text-muted">
          Nothing uploaded yet. Your worksheets will appear here once you add one.
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((sheet) => {
            const { href, cta } = destination(sheet.id, sheet)

            return (
              <li
                key={sheet.id}
                className="card flex flex-col overflow-hidden"
              >
                <Link
                  href={href}
                  className="block focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <div className="aspect-4/3 overflow-hidden bg-bg">
                    {thumbnailFor.get(sheet.id) ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={`/api/files/${thumbnailFor.get(sheet.id)}`}
                        alt={`First page of ${sheet.title}`}
                        loading="lazy"
                        width={400}
                        height={300}
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
                  <WorksheetTitle
                    worksheetId={sheet.id}
                    title={sheet.title}
                    href={href}
                  />

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

                  <div className="mt-3 flex items-center justify-between gap-2 pt-3">
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

      {(hasOlder || cursor) && (
        <nav
          aria-label="More worksheets"
          className="mt-6 flex flex-wrap items-center justify-between gap-3"
        >
          {cursor ? (
            <Link
              href={query ? `/worksheets?q=${encodeURIComponent(query)}` : '/worksheets'}
              className="btn btn-secondary sm:w-auto sm:px-4"
            >
              Back to the newest
            </Link>
          ) : (
            <span />
          )}

          {hasOlder && olderThan && (
            <Link
              href={`/worksheets?${new URLSearchParams({
                ...(query ? { q: query } : {}),
                before: olderThan.toISOString(),
              })}`}
              className="btn btn-secondary sm:w-auto sm:px-4"
            >
              Show older
            </Link>
          )}
        </nav>
      )}
    </main>
  )
}
