import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ViewTransition } from 'react'

import { auth } from '@/auth'
import {
  canSortTopicsHere,
  getAiStatus,
  getCredentialSummary,
  shouldOfferAiSetup,
} from '@/lib/ai/resolve'
import AiSetupPrompt from '@/components/ai-setup-prompt'
import TopicSorter from '@/components/topic-sorter'
import { AccuracyLabel, Meter } from '@/components/meter'
import { countMissedQuestions } from '@/lib/blooket/missed'
import { db } from '@/lib/db'
import TopicTree from '@/components/topic-tree'
import TrendArrow from '@/components/trend-arrow'
import {
  getAccuracyTrend,
  getAccuracyTrendBySubject,
  getDistractorPatterns,
  getOverview,
  getRecentWorksheets,
  getReviewForecast,
  listUntaggedWorksheets,
  getStudyCalendar,
  getStudyStreak,
  getTopicStats,
} from '@/lib/dashboard/queries'
import StudyCalendar from '@/components/study-calendar'
import {
  MIN_ATTEMPTS,
  rankFragile,
  rankWeaknesses,
  summarize,
} from '@/lib/dashboard/ranking'
import { buildTopicTree, pruneToAttempted } from '@/lib/dashboard/topic-tree'
import { topics } from '@/lib/db/schema'
import { pathBySlug } from '@/lib/taxonomy/trees'
import { destination } from '@/lib/worksheets/destination'

import AccuracyChart from './accuracy-chart'

export const metadata = { title: 'Dashboard · StudyBuddy' }

const PERCENT = new Intl.NumberFormat(undefined, {
  style: 'percent',
  maximumFractionDigits: 0,
})

const WHEN = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

/*
 * A section of the paper, not a card in a grid.
 *
 * The number in the margin is what does most of the work: it turns eight
 * equally-weighted tiles into a document with an order to it, and it gives
 * the eye somewhere to land other than the left edge of a heading. Purely
 * decorative, so it is hidden from the accessibility tree; the heading is
 * still the thing that names the section.
 */
function Panel({
  no,
  title,
  hint,
  children,
}: {
  no: string
  title: string
  hint?: string
  children: React.ReactNode
}) {
  const id = title.toLowerCase().replace(/\W+/g, '-')
  return (
    <section aria-labelledby={id} className="card h-full p-4 pt-3.5">
      <div className="flex items-baseline gap-2.5 border-b border-border pb-2">
        <span aria-hidden="true" className="section-no">
          {no}
        </span>
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
      </div>
      {hint && <p className="hint mb-3 text-pretty">{hint}</p>}
      <div className={hint ? '' : 'mt-3'}>{children}</div>
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-4 text-sm text-muted">{children}</p>
}

/*
 * One cell of the ledger strip.
 *
 * The dividers are drawn with negative margins on the cell rather than with
 * `divide-x`, because the strip reflows from five columns to three to two and
 * `divide-x` would keep drawing a rule down the left of whichever cell
 * happens to start a row. A right-hand border on every cell, clipped by the
 * strip's own border, wraps correctly at every breakpoint.
 */
function Figure({
  label,
  value,
  unit,
  href,
  lead = false,
}: {
  label: string
  value: number | string
  unit?: string
  href?: string
  lead?: boolean
}) {
  const figure = (
    <>
      {value}
      {unit && (
        <span className="ml-1 font-sans text-sm font-normal text-muted">
          {unit}
        </span>
      )}
    </>
  )

  return (
    <div className="-mb-px -mr-px border-b border-r border-border px-4 py-3">
      <dt className="eyebrow">{label}</dt>
      <dd
        className={`mt-1 font-display font-semibold tabular-nums ${
          lead ? 'text-3xl' : 'text-xl'
        }`}
      >
        {href ? (
          <Link
            href={href}
            className="text-accent underline decoration-1 underline-offset-4"
          >
            {figure}
          </Link>
        ) : (
          figure
        )}
      </dd>
    </div>
  )
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
    calendar,
    aiStatus,
    topicRows,
    untagged,
    credentials,
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
    getStudyCalendar(db, userId),
    getAiStatus(db, userId),
    db.select({ id: topics.id, slug: topics.slug }).from(topics),
    listUntaggedWorksheets(db, userId),
    getCredentialSummary(db, userId),
  ])

  const canSortHere = canSortTopicsHere(credentials)

  const paths = pathBySlug()

  const stats = rawStats.map((topic) => ({
    ...topic,
    topicPath: paths.get(topic.topicPath) ?? topic.topicName,
  }))

  const weakest = rankWeaknesses(stats).slice(0, 8)
  const fragile = rankFragile(stats)
    .filter((topic) => topic.unsureRate >= 0.25)
    .slice(0, 5)

  
  
  const subjectTree = pruneToAttempted(buildTopicTree(rawStats))
  const topicIdBySlug = new Map(topicRows.map((row) => [row.slug, row.id]))

  const thin = stats.map(summarize).filter((topic) => !topic.ranked).length
  const weekTotals = trend.map((p) => p.correct + p.unsure + p.wrong)
  const hasData = overview.attemptsLogged > 0

  
  
  
  
  
  const hasTrend = weekTotals.some((total) => total > 0)

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      {/*
        A masthead. The rule under it is ink-weight and the standfirst sits on
        it in mono, so the top of the page reads as the top of a document
        rather than as a heading that happens to be first.
      */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-rule-strong pb-4">
        <div>
          <p className="eyebrow">Your record so far</p>
          <h1 className="mt-1 text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
            Dashboard
          </h1>
        </div>
        <Link href="/upload" className="btn btn-primary sm:w-auto sm:px-5">
          Upload a worksheet
        </Link>
      </div>

      {/*
        The ledger strip.

        This was four tinted tiles of equal size, which gave the same weight to
        the number you act on and the number you glance at. Here it is one
        ruled band, divided the way a printed table is divided, and the two
        counts that are actually due get the wide columns and the display face.
        The rest are set small. Nothing is tinted: the hierarchy is size and
        position, which is what hierarchy is supposed to be made of.
      */}
      <dl className="mt-6 grid grid-cols-2 border border-border sm:grid-cols-3 lg:grid-cols-[1.3fr_1.3fr_1fr_1fr_1fr]">
        <Figure
          label="Due today"
          value={overview.dueNow}
          href={overview.dueNow > 0 ? '/review' : undefined}
          lead
        />
        <Figure
          label="To practise"
          value={overview.toPractise}
          href={overview.toPractise > 0 ? '/review' : undefined}
          lead
        />
        <Figure label="Questions tracked" value={overview.questionsTracked} />
        <Figure label="Worksheets" value={overview.worksheetsUploaded} />
        <Figure
          label="Study streak"
          value={streak > 0 ? `${streak}` : '0'}
          unit={streak === 1 ? 'day' : 'days'}
        />
      </dl>

      <p className="mt-2 text-right text-sm">
        <span className="eyebrow">AI status</span>{' '}
        <Link
          href={aiStatus.href}
          className="text-accent underline underline-offset-4"
        >
          {aiStatus.label}
        </Link>
      </p>

      {shouldOfferAiSetup(aiStatus) && <AiSetupPrompt />}

      {!hasData && (
        <p className="mt-6 rounded-2xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted">
          Nothing tracked yet. Upload a worksheet you have already done and mark
          which questions you missed. Everything here fills in from that.
        </p>
      )}

      {hasData && (
        <div className="mt-6 grid items-start gap-4 lg:grid-cols-12">
          <div className="lg:col-span-12">
            <Panel
              no="01"
              title="Weakest topics"
              hint={`Ranked by how confident we can be that the misses are real, not by raw percentage. A topic needs ${MIN_ATTEMPTS} attempts before it appears here.`}
            >
              {weakest.length === 0 ? (
                <Empty>
                  {untagged.length > 0 ? (
                    <>
                      {untagged.length === 1
                        ? 'One of your worksheets '
                        : `${untagged.length} of your worksheets `}
                      finished without topics assigned, so nothing from{' '}
                      {untagged.length === 1 ? 'it' : 'them'} can be ranked here.{' '}
                      {canSortHere ? (
                        <span className="mt-3 block">
                          <TopicSorter
                            worksheets={untagged}
                            label={
                              untagged.length === 1
                                ? 'Sort it into topics'
                                : 'Sort them into topics'
                            }
                          />
                        </span>
                      ) : (
                        <>
                          Open {untagged.length === 1 ? 'it' : 'one'} from{' '}
                          <Link
                            href="/worksheets"
                            className="text-accent underline underline-offset-2"
                          >
                            your worksheets
                          </Link>{' '}
                          to see why.
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      No topic has enough evidence yet.
                      {thin > 0 && ` ${thin} more still building up data.`}
                    </>
                  )}
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

          <div className="lg:col-span-7">
          <Panel
            no="02"
            title="By subject"
            hint="Rolled up from every question you have marked. Open a row to go deeper."
          >
            {subjectTree.length === 0 ? (
              <Empty>No subjects yet.</Empty>
            ) : (
              <>
                <TopicTree nodes={subjectTree} idBySlug={topicIdBySlug} />
                <p className="hint">
                  <Link
                    href="/topics"
                    className="text-accent underline underline-offset-2"
                  >
                    Browse every topic
                  </Link>
                  , including the ones you have not started.
                </p>
              </>
            )}
          </Panel>
          </div>

          <div className="lg:col-span-5">
          <Panel
            no="04"
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
          </div>

          <div className="lg:col-span-5">
          <Panel
            no="05"
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
                    <span className="shrink-0 text-sm tabular-nums text-muted">
                      {row.dueToday > 0 ? `${row.dueToday} today` : 'later this week'}
                      {row.dueThisWeek > row.dueToday && ` · ${row.dueThisWeek} this week`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          </div>

          <div className="lg:col-span-7">
            <Panel no="06" title="Accuracy over time" hint="Attempts per week.">
              {!hasTrend ? (
                <Empty>Not enough history yet.</Empty>
              ) : (
                <AccuracyChart overall={trend} bySubject={trendBySubject} />
              )}
            </Panel>
          </div>

          {/*
            Sits beside the accuracy chart on purpose: that one says how well
            the answers went, this one says whether you turned up at all, and
            the two questions are only worth anything read together.
          */}
          <div className="lg:col-span-5">
            <Panel
              no="03"
              title="The record"
              hint="Every day you have answered something, for the last half year."
            >
              <StudyCalendar days={calendar} streak={streak} />
            </Panel>
          </div>

          {distractors.length > 0 && (
            <div className="lg:col-span-12">
              <Panel
                no="07"
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
            <div className="lg:col-span-12">
              <Panel
                no="08"
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
        <Panel no="09" title="Recent worksheets">
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
