import {and, desc, eq, ilike, inArray, lt, sql} from 'drizzle-orm'
import Link from 'next/link'
import {redirect} from 'next/navigation'

import {auth} from '@/auth'
import {PageHead} from '@/components/page-head'
import {db} from '@/lib/db'
import {attempts, questions, worksheetPages, worksheets} from '@/lib/schema'
import {IS_QUESTION} from '@/lib/questions/queries'
import {destination} from '@/lib/upload'

import {DeleteWorksheetButton, WorksheetTitle} from './worksheets-client'

export const metadata = {title: 'Worksheets · StudyBuddy'}
export const dynamic = 'force-dynamic'

const WORKSHEETS_SHOWN = 50

function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (char) => '\\' + char)
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
  searchParams: Promise<{q?: string | string[]; before?: string | string[]}>
}) {
  const session = await auth()
  if (!session || !session.user || !session.user.id) redirect('/signin')

  const params = await searchParams

  function first(value: string | string[] | undefined) {
    if (Array.isArray(value)) return value[0]

    return value
  }

  let query = first(params.q)
  if (!query) query = ''
  query = query.trim().slice(0, 100)

  const beforeRaw = first(params.before)

  let cursor: Date | null = null

  if (beforeRaw) {
    const before = new Date(beforeRaw)
    if (!Number.isNaN(before.getTime())) cursor = before
  }

  const filters = [
    eq(worksheets.userId, session.user.id), eq(worksheets.origin, 'extracted'),
  ]

  if (query) filters.push(ilike(worksheets.title, '%' + likeLiteral(query) + '%'))
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
    .limit(WORKSHEETS_SHOWN + 1)

  const hasOlder = rows.length > WORKSHEETS_SHOWN
  if (hasOlder) rows.pop()

  let olderThan = null
  if (rows.length > 0) olderThan = rows[rows.length - 1].createdAt

  const thumbnailFor = new Map<string, string>()

  if (rows.length > 0) {
    const ids = []
    for (const row of rows) ids.push(row.id)

    const thumbnails = await db
      .select({
        worksheetId: worksheetPages.worksheetId,
        imageKey: sql<string>`min(${worksheetPages.imageKey})`,
      })
      .from(worksheetPages)
      .where(inArray(worksheetPages.worksheetId, ids))
      .groupBy(worksheetPages.worksheetId)

    for (const row of thumbnails) thumbnailFor.set(row.worksheetId, row.imageKey)
  }

  let newestHref = '/worksheets'
  if (query) newestHref = '/worksheets?q=' + encodeURIComponent(query)

  let olderHref = '/worksheets'

  if (olderThan) {
    const search = new URLSearchParams()
    if (query) search.set('q', query)
    search.set('before', olderThan.toISOString())

    olderHref = '/worksheets?' + search.toString()
  }

  let emptyMessage: React.ReactNode = null
  if (rows.length === 0) {
    if (query) {
      emptyMessage = (
        <>
          Nothing matches “{query}”.{' '}
          <Link href="/worksheets" className="text-accent">
            Show all worksheets
          </Link>
          .
        </>
      )
    } else if (cursor) {
      emptyMessage = (
        <>
          Nothing older to show.{' '}
          <Link href="/worksheets" className="text-accent">
            Back to the newest
          </Link>
          .
        </>
      )
    } else {
      emptyMessage = 'Nothing uploaded yet. Your worksheets will appear here once you add one.'
    }
  }

  return (
    <main className="w-full px-4 py-8 sm:px-6">
      <PageHead title="Your worksheets">
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

      {emptyMessage ? (
        <p className="rounded-2xl card-sunk px-4 py-12 text-center text-sm text-muted">
          {emptyMessage}
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((sheet) => {
            const target = destination(sheet.id, sheet)
            const href = target.href
            const cta = target.cta

            const thumbnail = thumbnailFor.get(sheet.id)

            let statusStyle = STATUS_STYLE[sheet.status]
            if (!statusStyle) statusStyle = 'text-muted'

            let statusLabel = STATUS_LABEL[sheet.status]
            if (!statusLabel) statusLabel = sheet.status

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
                    {thumbnail && (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={'/api/files/' + thumbnail}
                        alt={'First page of ' + sheet.title}
                        loading="lazy"
                        width={400}
                        height={300}
                        className="size-full object-cover object-top"
                      />
                    )}
                    {!thumbnail && (
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
                    {sheet.uncheckedCount > 0 && (
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
                      href={'/api/export/blooket/' + sheet.id}
                      download
                      className="mt-2 self-start text-sm text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      Export missed to Blooket
                    </a>
                  )}

                  <div className="mt-3 flex items-center justify-between gap-2 pt-3">
                    <span className={'text-xs font-medium ' + statusStyle}>
                      {statusLabel}
                    </span>
                    <div className="flex items-center gap-3">
                      <Link
                        href={href}
                        className="text-sm text-accent"
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
          {cursor && (
            <Link href={newestHref} className="btn btn-secondary sm:w-auto sm:px-4">
              Back to the newest
            </Link>
          )}

          {!cursor && <span />}

          {hasOlder && olderThan && (
            <Link href={olderHref} className="btn btn-secondary sm:w-auto sm:px-4">
              Show older
            </Link>
          )}
        </nav>
      )}
    </main>
  )
}
