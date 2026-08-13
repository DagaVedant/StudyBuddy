import { and, desc, eq, lte, sql } from 'drizzle-orm'

import { unwrapDriverRows as rows } from '@/lib/db/rows'
import { IS_QUESTION } from '@/lib/questions/is-question'
import { inReviewQueue } from '@/lib/review/queue'
import {
  attempts,
  questionTopics,
  questions,
  reviewCards,
  topics,
  worksheets,
} from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'

import { MIN_ATTEMPTS, type TopicStats } from './ranking'

export async function getTopicStats(db: Db, userId: string): Promise<TopicStats[]> {
  const result = await db
    .select({
      topicId: topics.id,
      topicName: topics.name,
      slug: topics.slug,
      subjectRoot: topics.subjectRoot,
      correct: sql<number>`count(*) filter (where ${attempts.outcome} = 'correct')::int`,
      unsure: sql<number>`count(*) filter (where ${attempts.outcome} = 'unsure')::int`,
      wrong: sql<number>`count(*) filter (where ${attempts.outcome} = 'wrong')::int`,
    })
    .from(attempts)
    .innerJoin(
      questionTopics,
      and(
        eq(questionTopics.questionId, attempts.questionId),
        eq(questionTopics.isPrimary, true),
      ),
    )
    .innerJoin(topics, eq(topics.id, questionTopics.topicId))
    .where(eq(attempts.userId, userId))
    .groupBy(topics.id, topics.name, topics.slug, topics.subjectRoot)

  return result.map((row) => ({
    topicId: row.topicId,
    topicName: row.topicName,

    topicPath: row.slug,
    subjectRoot: row.subjectRoot,
    correct: Number(row.correct),
    unsure: Number(row.unsure),
    wrong: Number(row.wrong),
  }))
}

export interface Overview {
  questionsTracked: number
  worksheetsUploaded: number
  /** In the queue and scheduled for today or earlier. */
  dueNow: number
  /**
   * The whole review queue: every question got wrong or guessed that has not
   * been retired with "Got it", whatever the scheduler says about it.
   *
   * This replaced a "due this week" count, which stopped meaning anything once
   * the queue stopped hiding what was not due yet.
   */
  toPractise: number
  attemptsLogged: number
}

export async function getOverview(db: Db, userId: string): Promise<Overview> {
  const now = new Date()

  const [counts] = rows<{
    questions_tracked: number
    worksheets_uploaded: number
    attempts_logged: number
  }>(
    await db.execute(sql`
      select
        (select count(*) from ${questions}
          where ${questions.userId} = ${userId} and ${IS_QUESTION})::int
          as questions_tracked,
        (select count(*) from ${worksheets} where ${worksheets.userId} = ${userId})::int
          as worksheets_uploaded,
        (select count(*) from ${attempts} where ${attempts.userId} = ${userId})::int
          as attempts_logged
    `),
  )

  // Both counts are over the review queue, which is the same set the review tab
  // draws from, so the tiles and the tab cannot disagree. A card for a question
  // the student got right is not in either: markup writes one for every
  // question on the paper and those were never what this screen is about.
  const [dueNow] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(reviewCards)
    .where(
      and(
        eq(reviewCards.userId, userId),
        inReviewQueue(userId),
        lte(reviewCards.dueAt, now),
      ),
    )

  const [queued] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(reviewCards)
    .where(and(eq(reviewCards.userId, userId), inReviewQueue(userId)))

  return {
    questionsTracked: Number(counts?.questions_tracked ?? 0),
    worksheetsUploaded: Number(counts?.worksheets_uploaded ?? 0),
    attemptsLogged: Number(counts?.attempts_logged ?? 0),
    dueNow: Number(dueNow?.value ?? 0),
    toPractise: Number(queued?.value ?? 0),
  }
}

export interface TrendPoint {
  weekStart: string
  correct: number
  unsure: number
  wrong: number
}

/**
 * One row per week, including the weeks nothing happened in.
 *
 * This used to group the attempts and return whatever buckets came back, which
 * meant the chart's bars were weeks-with-attempts rather than weeks. Twelve
 * bars read as twelve consecutive weeks whatever they were, so a student who
 * practised in March and again in June saw two adjacent bars and a flat run
 * between them that did not exist. Worse in the other direction: a gap during
 * a bad patch closed up, and the chart showed steady work.
 *
 * The weeks are generated in SQL rather than in JS so the bucket boundaries are
 * Postgres's own. `date_trunc('week', ...)` starts on a Monday, and rebuilding
 * that here would be one timezone assumption away from bars that do not line up
 * with the rows they are counting.
 */
export async function getAccuracyTrend(
  db: Db,
  userId: string,
  weeks = 12,
): Promise<TrendPoint[]> {
  const result = rows<{
    week_start: string
    correct: number
    unsure: number
    wrong: number
  }>(
    await db.execute(sql`
      select
        to_char(week.start, 'YYYY-MM-DD') as week_start,
        count(a.id) filter (where a.outcome = 'correct')::int as correct,
        count(a.id) filter (where a.outcome = 'unsure')::int  as unsure,
        count(a.id) filter (where a.outcome = 'wrong')::int   as wrong
      from generate_series(
        date_trunc('week', now()) - make_interval(weeks => ${weeks - 1}),
        date_trunc('week', now()),
        interval '1 week'
      ) as week(start)
      left join ${attempts} a
        on a.user_id = ${userId}
        and date_trunc('week', a.created_at) = week.start
      group by week.start
      order by week.start
    `),
  )

  return result.map((row) => ({
    weekStart: row.week_start,
    correct: Number(row.correct),
    unsure: Number(row.unsure),
    wrong: Number(row.wrong),
  }))
}

export interface RecentWorksheet {
  id: string
  title: string
  status: string
  pageCount: number
  createdAt: Date
  questionCount: number
  wrongCount: number
  /** Marks recorded from the markup flow, which a worksheet only gets once. */
  markedCount: number
}

export async function getRecentWorksheets(
  db: Db,
  userId: string,
  limit = 8,
): Promise<RecentWorksheet[]> {
  const result = await db
    .select({
      id: worksheets.id,
      title: worksheets.title,
      status: worksheets.status,
      pageCount: worksheets.pageCount,
      createdAt: worksheets.createdAt,
      // The same predicate the worksheets page counts with. These two numbers
      // describe the same paper on two screens, and they disagreed.
      questionCount: sql<number>`count(distinct ${questions.id}) filter (where ${IS_QUESTION})::int`,
      wrongCount: sql<number>`count(distinct ${attempts.id}) filter (where ${attempts.outcome} = 'wrong')::int`,
      markedCount: sql<number>`count(distinct ${attempts.id}) filter (where ${attempts.source} = 'markup')::int`,
    })
    .from(worksheets)
    .leftJoin(questions, eq(questions.worksheetId, worksheets.id))
    .leftJoin(attempts, eq(attempts.questionId, questions.id))
    .where(eq(worksheets.userId, userId))
    .groupBy(
      worksheets.id,
      worksheets.title,
      worksheets.status,
      worksheets.pageCount,
      worksheets.createdAt,
    )
    .orderBy(desc(worksheets.createdAt))
    .limit(limit)

  return result.map((row) => ({
    ...row,
    questionCount: Number(row.questionCount),
    wrongCount: Number(row.wrongCount),
    markedCount: Number(row.markedCount),
  }))
}

export interface DistractorPattern {
  questionId: string
  promptText: string
  choiceLabel: string
  choiceText: string
  timesChosen: number
}

export async function getDistractorPatterns(
  db: Db,
  userId: string,
  limit = 5,
): Promise<DistractorPattern[]> {
  return rows<DistractorPattern>(
    await db.execute(sql`
      select
        q.id            as "questionId",
        q.prompt_text   as "promptText",
        c.label         as "choiceLabel",
        c.text          as "choiceText",
        count(*)::int   as "timesChosen"
      from attempts a
      join answer_choices c on c.id = a.selected_choice_id
      join questions q on q.id = a.question_id
      where a.user_id = ${userId} and a.outcome = 'wrong'
      group by q.id, q.prompt_text, c.label, c.text
      having count(*) > 1
      order by count(*) desc
      limit ${limit}
    `),
  )
}

export interface AccountAccuracy {
  correct: number
  attempts: number
  accuracy: number
  ranked: boolean
}

/**
 * Accuracy across every attempt on the account, not per topic.
 *
 * `summarize` in `lib/dashboard/ranking.ts` does the same division for one
 * topic's rows; this is the same arithmetic over all of them; for the profile
 * page's stats summary, which is a personal record rather than something to
 * act on, so it draws from the whole history rather than only what counts
 * toward a ranked weakness.
 */
export async function getAccountAccuracy(db: Db, userId: string): Promise<AccountAccuracy> {
  const [row] = rows<{ correct: number; total: number }>(
    await db.execute(sql`
      select
        count(*) filter (where ${attempts.outcome} = 'correct')::int as correct,
        count(*)::int as total
      from ${attempts}
      where ${attempts.userId} = ${userId}
    `),
  )

  const correct = row?.correct ?? 0
  const total = row?.total ?? 0

  return {
    correct,
    attempts: total,
    accuracy: total > 0 ? correct / total : 0,
    ranked: total >= MIN_ATTEMPTS,
  }
}

/**
 * How many days in a row, ending today or yesterday, carry at least one
 * attempt.
 *
 * Any attempt counts, from review or from marking a worksheet: the streak is
 * about showing up, not about which screen. Days are UTC calendar days, the
 * same convention {@link getAccuracyTrend}'s week buckets already use, so the
 * two stay consistent with each other rather than one running on the reader's
 * clock and the other on the server's.
 *
 * Not broken by an empty today. A student who has not yet opened the app
 * today still has an active streak until the day actually passes with
 * nothing logged; starting the count from yesterday when today is empty is
 * what a streak is supposed to mean, and what every other streak feature
 * does. Computed live rather than stored: the input is a handful of rows per
 * active day, and storing a running count invites it drifting from what the
 * attempts actually show.
 */
export async function getStudyStreak(
  db: Db,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const days = rows<{ day: string }>(
    await db.execute(sql`
      select distinct to_char(date_trunc('day', ${attempts.createdAt}), 'YYYY-MM-DD') as day
      from ${attempts}
      where ${attempts.userId} = ${userId}
    `),
  )

  const daySet = new Set(days.map((row) => row.day))
  const dayKey = (d: Date) => d.toISOString().slice(0, 10)

  const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  if (!daySet.has(dayKey(cursor))) {
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }

  let streak = 0
  while (daySet.has(dayKey(cursor))) {
    streak += 1
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }

  return streak
}
