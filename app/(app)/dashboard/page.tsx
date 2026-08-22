import Link from 'next/link'
import {redirect} from 'next/navigation'

import {auth} from '@/auth'
import {canSortTopicsHere, getCredentialSummary} from '@/lib/ai/resolve'
import {TopicSorter} from '@/components/topic-sorter'
import {AccuracyLabel, Meter} from '@/components/meter'
import {countMissedQuestions} from '@/lib/blooket'
import {db} from '@/lib/db'
import {TopicTree} from '@/components/topic-tree'
import {getAccuracyTrend, getAccuracyTrendBySubject, getDistractorPatterns, getOverview, getRecentWorksheets, getReviewForecast, listUntaggedWorksheets, getStudyCalendar, getStudyStreak, getTopicStats} from '@/lib/dashboard'
import {StudyCalendar} from '@/components/study-calendar'
import {Underline} from '@/components/hand'
import {Callout, MarginNote, Note, PageFoot, SectionHead} from '@/components/note'
import {buildTopicTree, pruneToAttempted, rankFragile, rankWeaknesses, summarize, type TopicTrend} from '@/lib/ranking'
import {topics} from '@/lib/schema'
import {pathBySlug} from '@/lib/taxonomy'
import {destination} from '@/lib/upload'

import AccuracyChart from './accuracy-chart'

export const metadata = {title: 'Dashboard · StudyBuddy'}

const PERCENT = new Intl.NumberFormat(undefined, {
  style: 'percent',
  maximumFractionDigits: 0,
})

const WHEN = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

function Verdict({
  dueNow,
  weakest,
  hasData,
}: {
  dueNow: number
  weakest: {topicName: string} | undefined
  hasData: boolean
}) {
  if (!hasData) return <>Nothing tracked yet</>

  if (dueNow > 0) {
    return (
      <>
        <span className="relative whitespace-nowrap text-accent">
          {dueNow} {dueNow === 1 ? 'question' : 'questions'}
          <Underline />
        </span>{' '}
        {dueNow === 1 ? 'is' : 'are'} due for review today.
      </>
    )
  }

  if (weakest) {
    return (
      <>
        Nothing is due today.{' '}
        <span className="relative whitespace-nowrap text-accent">
          {weakest.topicName}
        </span>{' '}
        is your weakest topic right now.
      </>
    )
  }

  return <>Nothing is due today, and nothing looks shaky.</>
}

function Empty({children}: {children: React.ReactNode}) {
  return <p className="py-1 text-sm text-muted">{children}</p>
}

function Figure({
  label,
  value,
  unit,
  href,
}: {
  label: string
  value: number | string
  unit?: string
  href?: string
}) {
  const figure = (
    <>
      {value}
      {unit && (
        <span className="ml-1 font-sans text-xs font-normal text-muted">{unit}</span>
      )}
    </>
  )

  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="font-display text-base font-semibold tabular-nums">
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

function TrendArrow({trend}: {trend: TopicTrend}) {
  if (trend === null) return null

  const face = {
    up: {glyph: '↑', className: 'text-success', label: 'Improving'},
    down: {glyph: '↓', className: 'text-danger', label: 'Getting worse'},
    flat: {glyph: '→', className: 'text-muted', label: 'Holding steady'},
  }[trend]

  return (
    <>
      <span aria-hidden="true" className={`text-sm ${face.className}`}>
        {face.glyph}
      </span>
      <span className="sr-only">{face.label} since you started this topic.</span>
    </>
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
    topicRows,
    untagged,
    credentials,
  ] = await Promise.all([
    getOverview(db, userId), getTopicStats(db, userId), getAccuracyTrend(db, userId),
    getAccuracyTrendBySubject(db, userId), getReviewForecast(db, userId),
    getRecentWorksheets(db, userId), getDistractorPatterns(db, userId),
    countMissedQuestions(db, userId), getStudyStreak(db, userId),
    getStudyCalendar(db, userId),
    db.select({id: topics.id, slug: topics.slug}).from(topics),
    listUntaggedWorksheets(db, userId), getCredentialSummary(db, userId),
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
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5">
        <div className="max-w-2xl">
          <p className="eyebrow">Dashboard</p>
          <h1 className="mt-2 text-balance font-display text-3xl font-semibold leading-[1.08] tracking-tight sm:text-5xl">
            <Verdict
              dueNow={overview.dueNow}
              weakest={weakest[0]}
              hasData={hasData}
            />
          </h1>
        </div>
        <div className="flex flex-col gap-2">
          <Link href="/upload" className="btn btn-primary sm:w-auto sm:px-5">
            Upload a worksheet
          </Link>
          <Link
            href="/upload?sample=algebra-10"
            className="hint text-center underline underline-offset-2 hover:text-fg"
          >
            or start with a sample
          </Link>
        </div>
      </div>

      <div className="mt-6 border-b-2 border-rule-heavy" />

      <div className="mt-8 grid gap-x-12 gap-y-12 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="min-w-0">
          {hasData && (
            <div className="space-y-6">
              <Note labelledBy="costing">
                <SectionHead
                  id="costing"
                  title="What is costing you marks"
                />
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
                  <ul className="mt-1">
                    {weakest.map((topic, index) => (
                      <li key={topic.topicId}>
                        <Link
                          href={`/topics/${topic.topicId}`}
                          className={`block focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                            index === 0 ? 'pb-5 pt-1' : 'py-2.5'
                          }`}
                        >
                          <div className="flex items-baseline justify-between gap-3">
                            <span
                              className={
                                index === 0
                                  ? 'min-w-0 flex-1 font-display text-xl font-semibold leading-tight tracking-tight sm:text-2xl'
                                  : 'min-w-0 flex-1 truncate text-sm font-medium'
                              }
                            >
                              {topic.topicName}
                            </span>
                            <span className="flex shrink-0 items-baseline gap-1.5">
                              {index === 0 ? (
                                <span className="font-display text-3xl font-semibold tabular-nums sm:text-4xl">
                                  {PERCENT.format(topic.accuracy)}
                                </span>
                              ) : (
                                <AccuracyLabel
                                  accuracy={topic.accuracy}
                                  ranked
                                  attempts={topic.attempts}
                                />
                              )}
                              <TrendArrow trend={topic.trend} />
                            </span>
                          </div>
                          <p className="truncate text-xs text-muted">{topic.topicPath}</p>
                          <div className={index === 0 ? 'mt-3' : 'mt-2'}>
                            <Meter
                              accuracy={topic.accuracy}
                              label={topic.topicName}
                              thick={index === 0}
                            />
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
              </Note>

              <Note labelledBy="subject">
                <SectionHead
                  id="subject"
                  title="Subject by subject"
                />
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
              </Note>

              <Note labelledBy="guessed">
                <SectionHead
                  id="guessed"
                  title="Right but guessed"
                />
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
              </Note>

              <Note labelledBy="better">
                <SectionHead
                  id="better"
                  title="Are you getting better?"
                />
                {!hasTrend ? (
                  <Empty>Not enough history yet.</Empty>
                ) : (
                  <AccuracyChart overall={trend} bySubject={trendBySubject} />
                )}
              </Note>

              {distractors.length > 0 && (
                <Note labelledBy="reaching">
                  <SectionHead
                    id="reaching"
                    title="Answers you keep reaching for"
                  />
                  <ul>
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
                </Note>
              )}
            </div>
          )}

          <Note labelledBy="lately" className={hasData ? 'mt-6' : ''}>
            <SectionHead id="lately" title="Lately" />
            {recent.length === 0 ? (
              <Empty>Nothing uploaded yet.</Empty>
            ) : (
              <ul>
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
          </Note>
        </div>

        <aside className="space-y-4">
          <MarginNote label="At a glance">
            <dl className="space-y-1.5">
              <Figure
                label="Due today"
                value={overview.dueNow}
                href={overview.dueNow > 0 ? '/review' : undefined}
              />
              <Figure
                label="To practise"
                value={overview.toPractise}
                href={overview.toPractise > 0 ? '/review' : undefined}
              />
              <Figure label="Questions tracked" value={overview.questionsTracked} />
              <Figure label="Worksheets" value={overview.worksheetsUploaded} />
              <Figure
                label="Study streak"
                value={streak}
                unit={streak === 1 ? 'day' : 'days'}
              />
            </dl>
          </MarginNote>

          {hasData && (
            <MarginNote label="The record">
              <StudyCalendar days={calendar} streak={streak} weeks={17} />
            </MarginNote>
          )}

          {hasData && (
            <MarginNote label="Coming back to you">
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
            </MarginNote>
          )}

          {missed > 0 && (
            <Callout label="Play these in Blooket">
              <a
                href="/api/export/blooket"
                download
                className="btn btn-primary sm:w-auto sm:px-4"
              >
                Download CSV
              </a>
              <p className="hint">
                <span className="tabular-nums">{missed}</span>{' '}
                {missed === 1 ? 'question' : 'questions'} to draw from.
              </p>
            </Callout>
          )}
        </aside>
      </div>

      <PageFoot running="StudyBuddy · Dashboard" />
    </main>
  )
}
