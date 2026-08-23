import Link from 'next/link'
import {redirect} from 'next/navigation'

import {auth} from '@/auth'
import {canSortTopicsHere, getCredentialSummary} from '@/lib/ai/resolve'
import {TopicSorter} from '@/components/topic-sorter'
import {AccuracyLabel, Meter} from '@/components/meter'
import {countMissedQuestions} from '@/lib/blooket'
import {db} from '@/lib/db'
import {getAccuracyTrend, getAccuracyTrendBySubject, getDistractorPatterns, getOverview, getRecentWorksheets, listUntaggedWorksheets, getStudyCalendar, getStudyStreak, getTopicStats} from '@/lib/dashboard'
import {StudyCalendar} from '@/components/study-calendar'
import {Callout, MarginNote, Note, PageFoot, SectionHead} from '@/components/note'
import {rankWeaknesses, summarize, type TopicTrend} from '@/lib/ranking'
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
        <span className="whitespace-nowrap text-accent">
          {dueNow} {dueNow === 1 ? 'question' : 'questions'}
        </span>{' '}
        {dueNow === 1 ? 'is' : 'are'} due for review today.
      </>
    )
  }

  if (weakest) {
    return (
      <>
        Nothing is due today.{' '}
        <span className="whitespace-nowrap text-accent">{weakest.topicName}</span>{' '}
        is your weakest topic right now.
      </>
    )
  }

  return <>Nothing is due today, and nothing looks shaky.</>
}

function Empty({children}: {children: React.ReactNode}) {
  return <p className="py-1 text-sm text-muted">{children}</p>
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
    recent,
    distractors,
    missed,
    streak,
    calendar,
    untagged,
    credentials,
  ] = await Promise.all([
    getOverview(db, userId), getTopicStats(db, userId), getAccuracyTrend(db, userId),
    getAccuracyTrendBySubject(db, userId),
    getRecentWorksheets(db, userId, 3), getDistractorPatterns(db, userId),
    countMissedQuestions(db, userId), getStudyStreak(db, userId),
    getStudyCalendar(db, userId),
    listUntaggedWorksheets(db, userId), getCredentialSummary(db, userId),
  ])

  const canSortHere = canSortTopicsHere(credentials)

  const paths = pathBySlug()

  const stats = rawStats.map((topic) => ({
    ...topic,
    topicPath: paths.get(topic.topicPath) ?? topic.topicName,
  }))

  const weakest = rankWeaknesses(stats).slice(0, 3)

  const thin = stats.map(summarize).filter((topic) => !topic.ranked).length
  const weekTotals = trend.map((p) => p.correct + p.unsure + p.wrong)
  const hasData = overview.attemptsLogged > 0
  const hasTrend = weekTotals.some((total) => total > 0)

  return (
    <main className="w-full px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5">
        <div className="max-w-2xl">
          <p className="eyebrow">Dashboard</p>
          <h1 className="mt-2 whitespace-nowrap font-display text-3xl leading-tight tracking-tight sm:text-5xl">
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
            className="hint text-center hover:text-fg"
          >
            or start with a sample
          </Link>
        </div>
      </div>

      <div className="mt-10 space-y-10">
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
                              className="text-accent"
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
                    {weakest.map((topic) => (
                      <li key={topic.topicId}>
                        <Link
                          href={`/topics/${topic.topicId}`}
                          className="block py-2.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                        >
                          <div className="flex items-baseline justify-between gap-3">
                            <span className="min-w-0 flex-1 truncate text-sm font-medium">
                              {topic.topicName}
                            </span>
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
                        className="min-w-0 flex-1 truncate text-sm text-accent"
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

        <MarginNote label="The record">
          <p className="text-xs text-muted">
            <span className="tabular-nums">{overview.worksheetsUploaded}</span>{' '}
            {overview.worksheetsUploaded === 1 ? 'worksheet' : 'worksheets'} ·{' '}
            <span className="tabular-nums">{overview.questionsTracked}</span> questions
            tracked
          </p>
          {hasData && (
            <div className="mt-3">
              <StudyCalendar days={calendar} streak={streak} weeks={17} />
            </div>
          )}
        </MarginNote>

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
      </div>

      <PageFoot running="StudyBuddy · Dashboard" />
    </main>
  )
}
