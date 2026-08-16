import { and, desc, eq, ilike, inArray, lt, sql } from 'drizzle-orm'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { attempts, questions, worksheetPages, worksheets } from '@/lib/db/schema'
import { IS_QUESTION } from '@/lib/questions/sql'
import { destination } from '@/lib/worksheets/destination'

import DeleteWorksheetButton from './delete-worksheet-button'
import WorksheetTitle from './worksheet-title'

export const metadata = { title: 'Worksheets · StudyBuddy' }
export const dynamic = 'force-dynamic'

/**
 * How many worksheet cards one page of this renders.
 *
 * A page size now rather than a ceiling. It used to be both: there was no
 * paging and no search, so the fifty-first worksheet was simply gone from the
 * interface. The row stayed, its questions still counted towards the dashboard,
 * and the paper itself was unreachable. For something a student uses across a
 * school year, fifty is a number they reach.
 */
const WORKSHEETS_SHOWN = 50

/**
 * Escapes what LIKE treats as wildcards, so a search means what was typed.
 *
 * Without this a title search for "50%" matches every worksheet, and one for
 * "unit_4" matches "unit 4" as well. `\` is escaped first or it would escape
 * the escapes added after it.
 */
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

  /*
   * A cursor on `createdAt` rather than an offset.
   *
   * The list is ordered by it and uploads keep arriving, so an offset shifts
   * under the reader: upload something while looking at page two and the last
   * row of page one arrives again at the top of it. The cursor names a position
   * in the ordering instead, which does not move.
   *
   * An unparseable value is ignored rather than refused. This is a query string
   * somebody can edit or a link that has gone stale, and the newest page is a
   * better answer to both than an error.
   */
  const beforeRaw = first(params.before)
  const before = beforeRaw ? new Date(beforeRaw) : null
  const cursor = before && !Number.isNaN(before.getTime()) ? before : null

  const filters = [eq(worksheets.userId, session.user.id)]
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
      <p className="hint text-pretty">
        Every file you have uploaded, with the pages we read from it.
      </p>

      {/*
        A plain GET form, which needs no JavaScript and leaves the search in the
        URL where it can be bookmarked and shared. Submitting drops any cursor,
        because a position in the old ordering means nothing in the new one.
      */}
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
        <p className="rounded-2xl border border-dashed border-border px-4 py-12 text-center text-sm text-muted">
          Nothing matches “{query}”.{' '}
          <Link href="/worksheets" className="text-accent underline underline-offset-2">
            Show all worksheets
          </Link>
          .
        </p>
      ) : rows.length === 0 && cursor ? (
        // Reachable by following "Show older" as the last page empties, or from
        // a stale link. Not "nothing uploaded yet", which would be false.
        <p className="rounded-2xl border border-dashed border-border px-4 py-12 text-center text-sm text-muted">
          Nothing older to show.{' '}
          <Link href="/worksheets" className="text-accent underline underline-offset-2">
            Back to the newest
          </Link>
          .
        </p>
      ) : rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border px-4 py-12 text-center text-sm text-muted">
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
                  <div className="aspect-4/3 overflow-hidden border-b border-border bg-bg">
                    {thumbnailFor.get(sheet.id) ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={`/api/files/${thumbnailFor.get(sheet.id)}`}
                        alt={`First page of ${sheet.title}`}
                        loading="lazy"
                        /*
                          The 4:3 of the box, not the page's own ratio. These
                          exist so the browser can reserve the right space
                          before the bytes arrive, and what it renders is
                          `object-cover` inside `aspect-4/3` regardless of the
                          shape of the paper, so the real page dimensions
                          would describe something that never appears. The
                          numbers are a ratio; the class sizes it.
                        */
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

      {(hasOlder || cursor) && (
        <nav
          aria-label="More worksheets"
          className="mt-6 flex flex-wrap items-center justify-between gap-3"
        >
          {/*
            Back to the newest rather than a previous-page link. A cursor knows
            where it is and not where it came from, and threading a stack of
            them through the URL to offer one button is a poor trade against
            the search box directly above.
          */}
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
