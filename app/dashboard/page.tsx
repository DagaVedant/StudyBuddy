import Link from 'next/link'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import { AccuracyLabel, Meter } from '@/components/meter'
import { db } from '@/lib/db'
import {
  getAccuracyTrend,
  getDistractorPatterns,
  getOverview,
  getRecentWorksheets,
  getTopicStats,
  type Db,
} from '@/lib/dashboard/queries'
import {
  MIN_ATTEMPTS,
  rankFragile,
  rankWeaknesses,
  rollUp,
  summarize,
} from '@/lib/dashboard/ranking'
import { flattenTaxonomy } from '@/lib/taxonomy/trees'

export const metadata = { title: 'Dashboard · StudyBuddy' }

const PERCENT = new Intl.NumberFormat(undefined, {
  style: 'percent',
  maximumFractionDigits: 0,
})

function Panel({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: React.ReactNode
}) {
  const id = title.toLowerCase().replace(/\W+/g, '-')
  return (
    <section aria-labelledby={id} className="rounded border border-border bg-surface p-4">
      <h2 id={id} className="text-sm font-medium">
        {title}
      </h2>
      {hint && <p className="hint mb-3 text-pretty">{hint}</p>}
      <div className={hint ? '' : 'mt-3'}>{children}</div>
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-4 text-sm text-muted">{children}</p>
}

/* Accuracy is a single ratio against a limit, so it renders as a meter — see
   components/meter.tsx for why that beats a two-slice donut. */

export default async function DashboardPage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/signin')

  const userId = session.user.id
  const client = db as unknown as Db

  const [overview, rawStats, trend, recent, distractors] = await Promise.all([
    getOverview(client, userId),
    getTopicStats(client, userId),
    getAccuracyTrend(client, userId),
    getRecentWorksheets(client, userId),
    getDistractorPatterns(client, userId),
  ])

  // Query returns slugs; the taxonomy has the readable paths.
  const taxonomy = flattenTaxonomy()
  const pathBySlug = new Map(taxonomy.map((topic) => [topic.slug, topic.path]))
  const nameBySlug = new Map(taxonomy.map((topic) => [topic.slug, topic.name]))

  const stats = rawStats.map((topic) => ({
    ...topic,
    topicPath: pathBySlug.get(topic.topicPath) ?? topic.topicName,
  }))

  const weakest = rankWeaknesses(stats).slice(0, 8)
  const fragile = rankFragile(stats)
    .filter((topic) => topic.unsureRate >= 0.25)
    .slice(0, 5)

  const bySubject = rollUp(
    stats,
    (topic) => topic.subjectRoot,
    (topic) => nameBySlug.get(topic.subjectRoot) ?? topic.subjectRoot,
  )

  const thin = stats.map(summarize).filter((topic) => !topic.ranked).length
  const maxWeek = Math.max(1, ...trend.map((p) => p.correct + p.unsure + p.wrong))
  const hasData = overview.attemptsLogged > 0

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-balance text-2xl font-semibold tracking-tight">Dashboard</h1>
        <Link href="/upload" className="btn btn-primary sm:w-auto sm:px-4">
          Upload a Worksheet
        </Link>
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded border border-border bg-border sm:grid-cols-4">
        {[
          { label: 'Due now', value: overview.dueNow, href: '/review' },
          { label: 'Due this week', value: overview.dueThisWeek },
          { label: 'Questions tracked', value: overview.questionsTracked },
          { label: 'Worksheets', value: overview.worksheetsUploaded },
        ].map((stat) => (
          <div key={stat.label} className="bg-surface px-4 py-3">
            <dt className="text-sm text-muted">{stat.label}</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums">
              {stat.href && stat.value > 0 ? (
                <Link
                  href={stat.href}
                  className="text-accent underline underline-offset-4"
                >
                  {stat.value}
                </Link>
              ) : (
                stat.value
              )}
            </dd>
          </div>
        ))}
      </dl>

      {!hasData && (
        <p className="mt-6 rounded border border-dashed border-border px-4 py-8 text-center text-sm text-muted">
          Nothing tracked yet. Upload a worksheet you have already done and mark
          which questions you missed — everything here fills in from that.
        </p>
      )}

      {hasData && (
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <div className="lg:col-span-2">
            <Panel
              title="Weakest topics"
              hint={`Ranked by how confident we can be that the misses are real, not by raw percentage. A topic needs ${MIN_ATTEMPTS} attempts before it appears here.`}
            >
              {weakest.length === 0 ? (
                <Empty>
                  No topic has enough evidence yet
                  {thin > 0 && ` — ${thin} still building up data`}.
                </Empty>
              ) : (
                <ul className="divide-y divide-border">
                  {weakest.map((topic) => (
                    <li key={topic.topicId}>
                      <Link
                        href={`/topics/${topic.topicId}`}
                        className="block py-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">
                            {topic.topicName}
                          </span>
                          <AccuracyLabel
                            accuracy={topic.accuracy}
                            ranked
                            attempts={topic.attempts}
                          />
                        </div>
                        <p className="truncate text-xs text-muted">{topic.topicPath}</p>
                        <div className="mt-2">
                          <Meter accuracy={topic.accuracy} label={topic.topicName} />
                        </div>
                        <p className="mt-1 text-xs tabular-nums text-muted">
                          {topic.wrong} missed of {topic.attempts}
                          {topic.unsure > 0 && ` · ${topic.unsure} unsure`}
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <Panel
            title="By subject"
            hint="Rolled up from every question you have marked."
          >
            {bySubject.length === 0 ? (
              <Empty>No subjects yet.</Empty>
            ) : (
              <ul className="space-y-3">
                {bySubject.map((subject) => (
                  <li key={subject.topicId}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-sm">{subject.topicName}</span>
                      <span className="shrink-0 text-sm tabular-nums text-muted">
                        {subject.ranked
                          ? PERCENT.format(subject.accuracy)
                          : 'Not enough data'}
                      </span>
                    </div>
                    <div className="mt-1.5">
                      <Meter
                        accuracy={subject.accuracy}
                        ranked={subject.ranked}
                        label={subject.topicName}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel
            title="Right but guessed"
            hint="High accuracy with a high unsure rate is fragile, not strong."
          >
            {fragile.length === 0 ? (
              <Empty>Nothing looks shaky right now.</Empty>
            ) : (
              <ul className="space-y-2">
                {fragile.map((topic) => (
                  <li key={topic.topicId} className="flex items-baseline gap-3">
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {topic.topicName}
                    </span>
                    <span className="shrink-0 text-sm tabular-nums text-muted">
                      {PERCENT.format(topic.unsureRate)} guessed
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <div className="lg:col-span-2">
            <Panel title="Accuracy over time" hint="Attempts per week.">
              {trend.length === 0 ? (
                <Empty>Not enough history yet.</Empty>
              ) : (
                <>
                  <div className="flex h-28 items-end gap-1" aria-hidden="true">
                    {trend.map((point) => {
                      const total = point.correct + point.unsure + point.wrong
                      const scale = (value: number) => (value / maxWeek) * 100
                      return (
                        <div
                          key={point.weekStart}
                          className="flex min-w-0 flex-1 flex-col justify-end"
                          title={`${point.weekStart}: ${point.correct} correct, ${point.unsure} unsure, ${point.wrong} missed`}
                        >
                          <div
                            className="w-full rounded-t-sm bg-danger/70"
                            style={{ height: `${scale(point.wrong)}%` }}
                          />
                          <div
                            className="w-full bg-muted/50"
                            style={{ height: `${scale(point.unsure)}%` }}
                          />
                          <div
                            className="w-full bg-accent"
                            style={{ height: `${scale(point.correct)}%` }}
                          />
                          <span className="sr-only">{total}</span>
                        </div>
                      )
                    })}
                  </div>

                  <table className="sr-only">
                    <caption>Attempts by week</caption>
                    <thead>
                      <tr>
                        <th scope="col">Week</th>
                        <th scope="col">Correct</th>
                        <th scope="col">Unsure</th>
                        <th scope="col">Missed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trend.map((point) => (
                        <tr key={point.weekStart}>
                          <th scope="row">{point.weekStart}</th>
                          <td>{point.correct}</td>
                          <td>{point.unsure}</td>
                          <td>{point.wrong}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <p className="hint flex flex-wrap gap-x-4">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2 rounded-full bg-accent" aria-hidden="true" />
                      Correct
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2 rounded-full bg-muted/50" aria-hidden="true" />
                      Unsure
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2 rounded-full bg-danger/70" aria-hidden="true" />
                      Missed
                    </span>
                  </p>
                </>
              )}
            </Panel>
          </div>

          {distractors.length > 0 && (
            <div className="lg:col-span-2">
              <Panel
                title="Answers you keep reaching for"
                hint="The same wrong choice, more than once."
              >
                <ul className="divide-y divide-border">
                  {distractors.map((row) => (
                    <li key={`${row.questionId}-${row.choiceLabel}`} className="py-2">
                      <p className="truncate text-sm">{row.promptText}</p>
                      <p className="text-xs text-muted">
                        Picked{' '}
                        <span className="font-medium">
                          {row.choiceLabel}. {row.choiceText}
                        </span>{' '}
                        <span className="tabular-nums">{row.timesChosen}</span> times
                      </p>
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>
          )}
        </div>
      )}

      <div className="mt-4">
        <Panel title="Recent worksheets">
          {recent.length === 0 ? (
            <Empty>Nothing uploaded yet.</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {recent.map((sheet) => (
                <li key={sheet.id} className="flex items-center gap-3 py-2">
                  <Link
                    href={
                      sheet.status === 'awaiting_review'
                        ? `/worksheets/${sheet.id}/review`
                        : `/worksheets/${sheet.id}/markup`
                    }
                    className="min-w-0 flex-1 truncate text-sm text-accent underline underline-offset-2"
                  >
                    {sheet.title}
                  </Link>
                  <span className="shrink-0 text-xs tabular-nums text-muted">
                    {sheet.questionCount} questions
                    {sheet.wrongCount > 0 && ` · ${sheet.wrongCount} missed`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </main>
  )
}
