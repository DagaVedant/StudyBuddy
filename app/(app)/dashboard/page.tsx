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
import { PencilFrame, PencilRule, Underline } from '@/components/hand'
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
 * A section of the page.
 *
 * Each section sits on a white sheet, laid on the cream page and ruled round
 * in pencil. The frame is drawn rather than bordered: four separate strokes
 * that wobble and overshoot their corners, which is what makes the page read
 * as something worked through by hand rather than rendered. The heading gets
 * a pencil rule under it for the same reason.
 *
 * The white is still doing the structural work. Pencil is thin, warm and low
 * contrast on purpose, so if it fails to paint the sections are still legibly
 * separate; it is the annotation on top, not the boundary.
 *
 * The broadsheet composition underneath is unchanged. Boxing the sections
 * does not turn this back into a grid of tiles, because the spans are still
 * unequal, the rows still alternate which side is wide, and the lead is still
 * set several sizes larger than everything around it.
 *
 * `lead` is the front-page treatment. Exactly one section on the page gets it
 * and it is the one that answers the question the page exists to answer;
 * everything else is set smaller so that it can be.
 *
 * The number in the margin is optional, and that is the point: it was
 * originally on all nine sections, evenly, and a system applied without a
 * single exception is itself a machine tell. Numbered means "part of the
 * argument the data is making", read in order. The record, the queue, the
 * export and the log are unnumbered because they are not steps in it.
 *
 * Decorative, so it is hidden from the accessibility tree; the heading is
 * still the thing that names the section.
 */
function Panel({
  no,
  title,
  hint,
  lead = false,
  children,
}: {
  no?: string
  title: string
  hint?: string
  lead?: boolean
  children: React.ReactNode
}) {
  const id = title.toLowerCase().replace(/\W+/g, '-')
  return (
    <section
      aria-labelledby={id}
      className={`card h-full ${lead ? 'p-6 sm:p-7' : 'p-5'}`}
    >
      <PencilFrame />

      <div className="flex items-baseline gap-2.5">
        {no && (
          <span aria-hidden="true" className="section-no">
            {no}
          </span>
        )}
        <h2
          id={id}
          className={
            lead
              ? 'text-balance font-display text-2xl font-semibold leading-tight tracking-tight sm:text-3xl'
              : 'font-display text-lg font-semibold tracking-tight'
          }
        >
          {title}
        </h2>
      </div>
      <div className={lead ? 'mt-2 max-w-[16rem]' : 'mt-1.5 max-w-[11rem]'}>
        <PencilRule />
      </div>

      {hint && <p className="hint max-w-prose text-pretty">{hint}</p>}
      <div className={hint ? 'mt-4' : 'mt-3'}>{children}</div>
    </section>
  )
}

/*
 * What the dashboard says before you have read any of it.
 *
 * Three states, in the order they matter: there is work waiting, there is no
 * work waiting but there is a weakness worth naming, or there is nothing here
 * yet. Each is a whole sentence rather than a metric, because a sentence can
 * be understood without first learning what the number means.
 *
 * The hand-drawn underline goes on the one phrase you are meant to act on and
 * nowhere else.
 */
function Verdict({
  dueNow,
  weakest,
  hasData,
}: {
  dueNow: number
  weakest: { topicName: string } | undefined
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

/* `py-1`, not `py-4`: the Panel already puts space under the hint, and the
   two together left a visible hole above every empty section. */
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-1 text-sm text-muted">{children}</p>
}

/*
 * One cell of the ledger strip.
 *
 * The cells used to be divided by rules. They are separated by their own
 * right-hand padding now, which survives the strip reflowing from five
 * columns to three to two without any of the wrapping problems a rule has:
 * there is no line to end up on the wrong edge of a row.
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
    <div className="py-1">
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
        The verdict.

        The page used to open with the word "Dashboard" set large, which is
        the least informative thing it could possibly say: the nav already
        names the page, and a heading that repeats the nav is a heading doing
        no work. It opens with the answer instead, and the answer is different
        depending on what is actually true, so this is the one part of the
        page that cannot be mistaken for a template.

        It is the h1 because it genuinely is what the page is about. The word
        "Dashboard" survives as the eyebrow, which is the right size for a
        label nobody needs to read.
      */}
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
          {!hasData && (
            <p className="mt-3 text-pretty text-muted">
              Upload a worksheet you have already done and mark which questions
              you missed. Everything here fills in from that.
            </p>
          )}
        </div>
        <Link href="/upload" className="btn btn-primary sm:w-auto sm:px-5">
          Upload a worksheet
        </Link>
      </div>

      {/*
        The ledger strip.

        This was four tinted tiles of equal size, which gave the same weight to
        the number you act on and the number you glance at. Here the two counts
        that are actually due get the wide columns and the display face and the
        rest are set small, with nothing boxed or tinted: the hierarchy is size
        and position, which is what hierarchy is supposed to be made of.
      */}
      <dl className="mt-8 grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3 xl:grid-cols-[1.3fr_1.3fr_1fr_1fr_1fr]">
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

      <p className="mt-3 flex items-baseline justify-end gap-2 text-sm">
        <span className="eyebrow">AI status</span>
        <Link
          href={aiStatus.href}
          className="text-accent underline underline-offset-4"
        >
          {aiStatus.label}
        </Link>
      </p>

      {shouldOfferAiSetup(aiStatus) && <AiSetupPrompt />}

      {/*
        The spread.

        Laid out as a broadsheet rather than as a grid of equal panels: one
        lead story running seven columns, a five-column rail beside it, and
        then rows that alternate which side is wide. The alternation is the
        whole trick. A page where every row is split the same way reads as a
        grid however unequal the halves are; swapping the wide side each row
        is what makes it read as a composed page.

        The right-hand items are dropped by `lg:mt-9` so the rows do not all
        start on one line, which is what keeps a page of boxes from settling
        back into a tidy grid.

        Auto-placement, not explicit tracks: two of these sections only appear
        when there is something in them, and a fixed template would leave a
        hole where they are not.
      */}
      <div className="mt-10 grid items-start gap-x-8 gap-y-8 lg:grid-cols-12">
        {hasData && (
          <>
            <div className="lg:col-span-7">
              <Panel
              lead
              no="01"
              title="What is costing you marks"
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
                /*
                  The worst topic is set as a lead, not as the first row of a
                  list. It is the single most useful fact the page holds, and
                  ranking it first while drawing it identically to the seven
                  below is a hierarchy you have to read to notice.
                */
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
                          <ViewTransition
                            name={`topic-title-${topic.topicId}`}
                            share="topic-title"
                            default="none"
                          >
                            <span
                              className={
                                index === 0
                                  ? 'min-w-0 flex-1 font-display text-xl font-semibold leading-tight tracking-tight sm:text-2xl'
                                  : 'min-w-0 flex-1 truncate text-sm font-medium'
                              }
                            >
                              {topic.topicName}
                            </span>
                          </ViewTransition>
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
            </Panel>
            </div>

            {/* The rail. The record and the fragile list are both glanceable
                rather than read, so they stack in the narrow column. */}
            <div className="flex flex-col gap-8 lg:col-span-5 lg:mt-9">
              <Panel
              title="The record"
              hint="Every day you have answered something, for the last half year."
            >
              <StudyCalendar days={calendar} streak={streak} />
            </Panel>

              <Panel
            no="03"
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

            <div className="lg:col-span-4">
              <Panel
            no="02"
            title="Subject by subject"
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

            <div className="lg:col-span-8 lg:mt-9">
              <Panel no="04" title="Are you getting better?" hint="Attempts per week.">
              {!hasTrend ? (
                <Empty>Not enough history yet.</Empty>
              ) : (
                <AccuracyChart overall={trend} bySubject={trendBySubject} />
              )}
            </Panel>
            </div>

            {distractors.length > 0 && (
              <div className="lg:col-span-8">
                <Panel
                no="05"
                title="Answers you keep reaching for"
                hint="The same wrong choice, more than once."
              >
                <ul className="">
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

            <div className="lg:col-span-4 lg:mt-9">
              <Panel
            title="Coming back to you"
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

            {missed > 0 && (
              <div className="lg:col-span-5 lg:mt-9">
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
          </>
        )}

        <div className="lg:col-span-7">
          <Panel title="Lately">
          {recent.length === 0 ? (
            <Empty>Nothing uploaded yet.</Empty>
          ) : (
            <ul className="">
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
      </div>
    </main>
  )
}
