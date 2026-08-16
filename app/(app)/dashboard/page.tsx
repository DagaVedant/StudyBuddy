import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ViewTransition } from 'react'

import { auth } from '@/auth'
import { getAiStatus, shouldOfferAiSetup } from '@/lib/ai/resolve'
import AiSetupPrompt from '@/components/ai-setup-prompt'
import { AccuracyLabel, Meter } from '@/components/meter'
import { countMissedQuestions } from '@/lib/blooket/missed'
import { db } from '@/lib/db'
import TrendArrow from '@/components/trend-arrow'
import {
  getAccuracyTrend,
  getAccuracyTrendBySubject,
  getDistractorPatterns,
  getOverview,
  getRecentWorksheets,
  getReviewForecast,
  getStudyStreak,
  getTopicStats,
} from '@/lib/dashboard/queries'
import {
  MIN_ATTEMPTS,
  rankFragile,
  rankWeaknesses,
  rollUp,
  summarize,
} from '@/lib/dashboard/ranking'
import { nameBySlug, pathBySlug } from '@/lib/taxonomy/trees'
import { destination } from '@/lib/worksheets/destination'

import AccuracyChart from './accuracy-chart'

export const metadata = { title: 'Dashboard · StudyBuddy' }

const PERCENT = new Intl.NumberFormat(undefined, {
  style: 'percent',
  maximumFractionDigits: 0,
})

/**
 * An upload date. Matches the worksheets page's own formatter, so the same
 * paper is dated identically on both screens.
 */
const WHEN = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
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
    <section aria-labelledby={id} className="card p-4">
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

export default async function DashboardPage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/signin')

  const userId = session.user.id

  const [
    overview,
    rawStats,
    trend,
    trendBySubject,
    forecast,
    recent,
    distractors,
    missed,
    streak,
    aiStatus,
  ] = await Promise.all([
    getOverview(db, userId),
    getTopicStats(db, userId),
    getAccuracyTrend(db, userId),
    getAccuracyTrendBySubject(db, userId),
    getReviewForecast(db, userId),
    getRecentWorksheets(db, userId),
    getDistractorPatterns(db, userId),
    countMissedQuestions(db, userId),
    getStudyStreak(db, userId),
    getAiStatus(db, userId),
  ])

  const paths = pathBySlug()
  const names = nameBySlug()

  const stats = rawStats.map((topic) => ({
    ...topic,
    topicPath: paths.get(topic.topicPath) ?? topic.topicName,
  }))

  const weakest = rankWeaknesses(stats).slice(0, 8)
  const fragile = rankFragile(stats)
    .filter((topic) => topic.unsureRate >= 0.25)
    .slice(0, 5)

  const bySubject = rollUp(
    stats,
    (topic) => topic.subjectRoot,
    (topic) => names.get(topic.subjectRoot) ?? topic.subjectRoot,
  )

  const thin = stats.map(summarize).filter((topic) => !topic.ranked).length
  const weekTotals = trend.map((p) => p.correct + p.unsure + p.wrong)
  const hasData = overview.attemptsLogged > 0

  // Not `trend.length`. Every week in the window is a row now, including the
  // empty ones, so the list is never empty and the length says nothing about
  // whether there is anything to draw. A student who has never practised would
  // have got twelve bars of height zero under a heading claiming to show their
  // accuracy over time.
  const hasTrend = weekTotals.some((total) => total > 0)

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-balance text-2xl font-extrabold tracking-tight">Dashboard</h1>
        <Link href="/upload" className="btn btn-primary sm:w-auto sm:px-4">
          Upload a worksheet
        </Link>
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Due today', value: overview.dueNow, href: '/review', tint: 'bg-tint-mint' },
          // The whole queue, not a second slice of time. "Later this week"
          // stopped meaning anything once the review tab stopped hiding what
          // the scheduler had not got to yet: everything is available, and
          // what this says is how much of it is left.
          {
            label: 'To practise',
            value: overview.toPractise,
            href: '/review',
            tint: 'bg-tint-peach',
          },
          {
            label: 'Questions tracked',
            value: overview.questionsTracked,
            tint: 'bg-tint-lavender',
          },
          { label: 'Worksheets', value: overview.worksheetsUploaded, tint: 'bg-tint-butter' },
        ].map((stat) => (
          <div key={stat.label} className={`rounded-2xl px-4 py-3.5 ${stat.tint}`}>
            <dt className="text-sm text-muted">{stat.label}</dt>
            <dd className="mt-1 text-2xl font-extrabold tabular-nums text-fg">
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

        {/*
          spec.md:398 asks the top strip to carry the streak and either trial
          pages remaining or AI status. These are cards, not tinted tiles, on
          purpose: the four above are progress counts a student acts on, and
          giving these two the same bright treatment would read them as a
          fifth and sixth count of the same kind, which they are not. Reusing
          one of the four tints instead of a plain card would have been worse:
          it would tie a metric to a colour that already means something else.
        */}
        <div className="card px-4 py-3.5">
          <dt className="text-sm text-muted">Study streak</dt>
          <dd className="mt-1 text-2xl font-extrabold tabular-nums text-fg">
            {streak > 0 ? `${streak} day${streak === 1 ? '' : 's'}` : '—'}
          </dd>
        </div>

        <div className="card px-4 py-3.5">
          {/*
            "AI status", not "AI setup", which is what spec.md:398 asks this
            slot to carry and what the value under it actually is. The label
            read as a link to a settings screen while the value said
            "3 trial worksheets left", so the two halves of one card were
            answering different questions.
          */}
          <dt className="text-sm text-muted">AI status</dt>
          <dd className="mt-1 text-lg font-semibold text-fg">
            <Link
              href={aiStatus.href}
              className="text-accent underline underline-offset-4"
            >
              {aiStatus.label}
            </Link>
          </dd>
        </div>
      </dl>

      {/*
        Above the panels rather than among them. The panels answer "what should
        I work on"; this answers "why will the next upload behave differently",
        which is only useful before they upload it.
      */}
      {shouldOfferAiSetup(aiStatus) && <AiSetupPrompt />}

      {!hasData && (
        <p className="mt-6 rounded-2xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted">
          Nothing tracked yet. Upload a worksheet you have already done and mark
          which questions you missed. Everything here fills in from that.
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
                  No topic has enough evidence yet.
                  {thin > 0 && ` ${thin} more still building up data.`}
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
                          {/* Pairs with the <h1> on /topics/[topicId]; see the
                              .topic-title rules in globals.css. Only this list
                              claims the name; the other panels can repeat a
                              topic, and two live elements sharing one
                              view-transition-name breaks the morph. */}
                          <ViewTransition
                            name={`topic-title-${topic.topicId}`}
                            share="topic-title"
                            default="none"
                          >
                            <span className="min-w-0 flex-1 truncate text-sm font-medium">
                              {topic.topicName}
                            </span>
                          </ViewTransition>
                          <span className="flex shrink-0 items-baseline gap-1.5">
                            <AccuracyLabel
                              accuracy={topic.accuracy}
                              ranked
                              attempts={topic.attempts}
                            />
                            <TrendArrow trend={topic.trend} />
                          </span>
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

          {/*
            spec.md:412's review forecast, and the panel worth building of the
            three that were missing. This screen's stated job (spec.md:392) is
            to answer "What should I do right now?", and the two counts in the
            top strip are totals with no topic in them: they say how much there
            is and never what it is. Placed directly under the weakest topics
            for that reason, where "what am I bad at" and "what is due" can be
            read together.
          */}
          <Panel
            title="Due for review"
            hint="What the scheduler has lined up, by topic."
          >
            {forecast.length === 0 ? (
              <Empty>Nothing due in the next seven days.</Empty>
            ) : (
              <ul className="space-y-2">
                {forecast.map((row) => (
                  <li key={row.topicId} className="flex items-baseline gap-3">
                    <Link
                      href={`/review?topic=${row.topicId}`}
                      className="min-w-0 flex-1 truncate text-sm text-accent underline underline-offset-2"
                    >
                      {row.topicName}
                    </Link>
                    {/*
                      Today's count is the actionable one, so it leads. The
                      week's total only appears when it differs, because "3
                      today · 3 this week" is two numbers saying one thing.
                    */}
                    <span className="shrink-0 text-sm tabular-nums text-muted">
                      {row.dueToday > 0 ? `${row.dueToday} today` : 'later this week'}
                      {row.dueThisWeek > row.dueToday && ` · ${row.dueThisWeek} this week`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <div className="lg:col-span-2">
            <Panel title="Accuracy over time" hint="Attempts per week.">
              {!hasTrend ? (
                <Empty>Not enough history yet.</Empty>
              ) : (
                <AccuracyChart overall={trend} bySubject={trendBySubject} />
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

          {missed > 0 && (
            <div className="lg:col-span-2">
              <Panel
                title="Play these in Blooket"
                hint="Every question you have got wrong, in Blooket's import format. In Blooket, choose Create a Set, then Import Questions, and upload the file."
              >
                <a
                  href="/api/export/blooket"
                  download
                  className="btn btn-primary sm:w-auto sm:px-4"
                >
                  Download CSV
                </a>
                <p className="hint">
                  <span className="tabular-nums">{missed}</span>{' '}
                  {missed === 1 ? 'question' : 'questions'} to draw from. Any we do
                  not hold an answer key for are left out, since Blooket needs the
                  right answer to score a question.
                </p>
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
                <li key={sheet.id} className="py-2.5">
                  <div className="flex items-baseline gap-3">
                    <Link
                      href={destination(sheet.id, sheet).href}
                      className="min-w-0 flex-1 truncate text-sm text-accent underline underline-offset-2"
                    >
                      {sheet.title}
                    </Link>
                    {/*
                      spec.md:414 asks this panel for a score, and it showed a
                      miss count: the same information upside down, and only
                      readable if you already knew the denominator. Shown only
                      once the paper has been marked, since before that there is
                      no score to report and "0%" would be a lie about a paper
                      nobody has sat down with yet.
                    */}
                    {sheet.markedCount > 0 && (
                      <span className="shrink-0 text-xs font-medium tabular-nums">
                        {PERCENT.format(sheet.correctCount / sheet.markedCount)}
                      </span>
                    )}
                  </div>

                  <p className="mt-0.5 text-xs tabular-nums text-muted">
                    {WHEN.format(sheet.createdAt)} · {sheet.questionCount}{' '}
                    {sheet.questionCount === 1 ? 'question' : 'questions'}
                    {sheet.wrongCount > 0 && ` · ${sheet.wrongCount} missed`}
                  </p>

                  {/*
                    Three at most. This is a summary line under a title, not the
                    subject drilldown, and a paper spanning nine topics would
                    otherwise push every other row off the panel.
                  */}
                  {sheet.topics.length > 0 && (
                    <p className="mt-1 truncate text-xs text-muted">
                      {sheet.topics
                        .slice(0, 3)
                        .map((topic) => topic.topicName)
                        .join(' · ')}
                      {sheet.topics.length > 3 && ` +${sheet.topics.length - 3}`}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </main>
  )
}
