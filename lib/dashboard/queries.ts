import { and, desc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm'

import { unwrapDriverRows as rows } from '@/lib/db/rows'
import { IS_QUESTION } from '@/lib/questions/sql'
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

/**
 * How much a topic's accuracy has to move before the arrow calls it a trend.
 *
 * Ten points. Below that the arrow would be reporting the difference between
 * four out of five and five out of six, which is not information a student
 * should change their evening around.
 */
const TREND_BAND = 0.1

export async function getTopicStats(db: Db, userId: string): Promise<TopicStats[]> {
  /*
   * spec.md:398's trend arrow, which was specified and never computed. The
   * example row is `38% (8/21) ↓`, and the arrow is the part that says whether
   * the 38% is the story so far or the story now.
   *
   * The comparison splits a topic's own attempts down the middle by time rather
   * than using a fixed window like "the last 30 days". A student works through a
   * subject in bursts, so a calendar window is empty for most topics most of the
   * time, and an arrow that is absent whenever the student took a fortnight off
   * is worse than no arrow. Halves are always populated once there are two
   * attempts, and they scale with however densely the topic was practised.
   *
   * `unsure` counts as correct on both sides, because it is: the answer was
   * right. Whether it was *confident* is panel 4's question and has its own
   * number, and folding it in here would make the arrow say two things at once.
   */
  const result = rows<{
    topic_id: string
    topic_name: string
    slug: string
    subject_root: string
    correct: number
    unsure: number
    wrong: number
    earlier_rate: string | null
    recent_rate: string | null
  }>(
    await db.execute(sql`
      with ranked as (
        select
          ${questionTopics.topicId} as topic_id,
          ${attempts.outcome} as outcome,
          row_number() over (
            partition by ${questionTopics.topicId}
            order by ${attempts.createdAt}, ${attempts.id}
          ) as seq,
          count(*) over (partition by ${questionTopics.topicId}) as total
        from ${attempts}
        join ${questionTopics}
          on ${questionTopics.questionId} = ${attempts.questionId}
          and ${questionTopics.isPrimary} = true
        where ${attempts.userId} = ${userId}
      )
      select
        t.id as topic_id,
        t.name as topic_name,
        t.slug,
        t.subject_root,
        count(*) filter (where r.outcome = 'correct')::int as correct,
        count(*) filter (where r.outcome = 'unsure')::int as unsure,
        count(*) filter (where r.outcome = 'wrong')::int as wrong,
        avg(case when r.outcome = 'wrong' then 0.0 else 1.0 end)
          filter (where r.seq <= r.total / 2.0) as earlier_rate,
        avg(case when r.outcome = 'wrong' then 0.0 else 1.0 end)
          filter (where r.seq > r.total / 2.0) as recent_rate
      from ranked r
      join ${topics} t on t.id = r.topic_id
      group by t.id, t.name, t.slug, t.subject_root
    `),
  )

  return result.map((row) => {
    const earlier = row.earlier_rate === null ? null : Number(row.earlier_rate)
    const recent = row.recent_rate === null ? null : Number(row.recent_rate)

    return {
      topicId: row.topic_id,
      topicName: row.topic_name,

      topicPath: row.slug,
      subjectRoot: row.subject_root,
      correct: Number(row.correct),
      unsure: Number(row.unsure),
      wrong: Number(row.wrong),
      trend: trendOf(earlier, recent),
    }
  })
}

/**
 * Which way a topic is going, or null when it is not going anywhere worth an
 * arrow. Null rather than 'flat' for "not enough to say": a flat arrow claims
 * steadiness, and one attempt in each half claims nothing.
 */
function trendOf(earlier: number | null, recent: number | null): TopicStats['trend'] {
  if (earlier === null || recent === null) return null

  const move = recent - earlier
  if (move > TREND_BAND) return 'up'
  if (move < -TREND_BAND) return 'down'
  return 'flat'
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

/**
 * How many of this student's worksheets finished with no topics on them.
 *
 * The weakness ranking, the forecast and the subject tree are all built from
 * `question_topics`, so a worksheet that finished untagged contributes to none
 * of them. The check screen says why at the time, and then the student marks the
 * paper and arrives at a dashboard with nothing on it and no memory of the
 * warning. "No topic has enough evidence yet" is the wrong explanation for that,
 * and it is the one they were getting.
 */
export async function countUntaggedWorksheets(
  db: Db,
  userId: string,
): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(worksheets)
    .where(
      and(eq(worksheets.userId, userId), isNotNull(worksheets.classificationError)),
    )

  return Number(row?.value ?? 0)
}

export interface ForecastRow {
  topicId: string
  topicName: string
  /** In the queue and scheduled for the end of today or earlier. */
  dueToday: number
  /** Including today. Everything landing in the next seven days. */
  dueThisWeek: number
}

/**
 * spec.md:412's review forecast: what is due today and this week, by topic.
 *
 * The panel the dashboard was missing, and the one worth building of the three
 * that were: the screen's stated job (spec.md:392) is to answer "What should I
 * do right now?", and a forecast broken down by topic is the panel that answers
 * it. The two counts in the top strip are not this. They are totals with no
 * topic in them, so they say how much there is and never what it is.
 *
 * Built on `inReviewQueue`, the same predicate the review tab draws from and the
 * same one the tiles count, because a third definition of "due" on the same
 * screen is how finding 109 happened.
 *
 * Bounded to the week rather than returning every topic with a card in it. This
 * is a forecast, and a topic whose next card lands in March is not a thing to
 * plan around today.
 */
export async function getReviewForecast(
  db: Db,
  userId: string,
  now: Date = new Date(),
): Promise<ForecastRow[]> {
  // Local end of day rather than `now + 24h`. "Due today" is a calendar answer,
  // and a card landing at 23:00 is due today whether it is 09:00 or 22:00 when
  // the dashboard is opened.
  const endOfToday = new Date(now)
  endOfToday.setHours(23, 59, 59, 999)

  const endOfWeek = new Date(now)
  endOfWeek.setDate(endOfWeek.getDate() + 7)

  // ISO strings with an explicit cast, not Date objects. A Date interpolated
  // into a raw fragment reaches the driver as something Postgres will not
  // compare against timestamptz.
  const today = endOfToday.toISOString()
  const week = endOfWeek.toISOString()

  const result = await db
    .select({
      topicId: topics.id,
      topicName: topics.name,
      dueToday: sql<number>`count(*) filter (where ${reviewCards.dueAt} <= ${today}::timestamptz)::int`,
      dueThisWeek: sql<number>`count(*)::int`,
    })
    .from(reviewCards)
    .innerJoin(
      questionTopics,
      and(
        eq(questionTopics.questionId, reviewCards.questionId),
        eq(questionTopics.isPrimary, true),
      ),
    )
    .innerJoin(topics, eq(topics.id, questionTopics.topicId))
    .where(
      and(
        eq(reviewCards.userId, userId),
        inReviewQueue(userId, now),
        sql`${reviewCards.dueAt} <= ${week}::timestamptz`,
      ),
    )
    .groupBy(topics.id, topics.name)
    .orderBy(desc(sql`count(*) filter (where ${reviewCards.dueAt} <= ${today}::timestamptz)`))

  return result.map((row) => ({
    topicId: row.topicId,
    topicName: row.topicName,
    dueToday: Number(row.dueToday),
    dueThisWeek: Number(row.dueThisWeek),
  }))
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

export interface SubjectTrend {
  subjectRoot: string
  points: TrendPoint[]
}

/**
 * spec.md:406's other half: the same weekly chart, per subject.
 *
 * "Toggleable overall vs. per-subject" was specified and only the overall half
 * was built, which answers "is any of this working" and cannot answer "is it
 * working *at the thing I have been grinding*". A student who spent a month on
 * geometry while coasting through algebra sees one flat line either way.
 *
 * The weeks come from the same `generate_series` as the overall chart and are
 * generated per subject, so every series has the same x-axis and the toggle
 * does not reshape the chart under the reader. Subjects with no attempts at all
 * are dropped: an all-zero series is a legend entry that teaches nothing.
 */
export async function getAccuracyTrendBySubject(
  db: Db,
  userId: string,
  weeks = 12,
): Promise<SubjectTrend[]> {
  const result = rows<{
    subject_root: string
    week_start: string
    correct: number
    unsure: number
    wrong: number
  }>(
    await db.execute(sql`
      with tagged as (
        select
          t.subject_root,
          a.outcome,
          date_trunc('week', a.created_at) as week_start
        from ${attempts} a
        join ${questionTopics} qt
          on qt.question_id = a.question_id and qt.is_primary = true
        join ${topics} t on t.id = qt.topic_id
        where a.user_id = ${userId}
      ),
      subject as (select distinct subject_root from tagged),
      week as (
        select generate_series(
          date_trunc('week', now()) - make_interval(weeks => ${weeks - 1}),
          date_trunc('week', now()),
          interval '1 week'
        ) as start
      )
      select
        s.subject_root,
        to_char(w.start, 'YYYY-MM-DD') as week_start,
        count(*) filter (where x.outcome = 'correct')::int as correct,
        count(*) filter (where x.outcome = 'unsure')::int  as unsure,
        count(*) filter (where x.outcome = 'wrong')::int   as wrong
      from subject s
      cross join week w
      left join tagged x
        on x.subject_root = s.subject_root and x.week_start = w.start
      group by s.subject_root, w.start
      order by s.subject_root, w.start
    `),
  )

  const bySubject = new Map<string, TrendPoint[]>()
  for (const row of result) {
    const points = bySubject.get(row.subject_root) ?? []
    points.push({
      weekStart: row.week_start,
      correct: Number(row.correct),
      unsure: Number(row.unsure),
      wrong: Number(row.wrong),
    })
    bySubject.set(row.subject_root, points)
  }

  return [...bySubject.entries()]
    .map(([subjectRoot, points]) => ({ subjectRoot, points }))
    .sort((a, b) => a.subjectRoot.localeCompare(b.subjectRoot))
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
  /**
   * Right first time, out of `markedCount`. spec.md:414 asks this panel for a
   * score, and the panel showed a miss count instead, which is the same
   * information upside down and only if you already know the denominator.
   *
   * `unsure` is not counted here. The answer was right, but this is the number a
   * student reads as "how did I do", and a guess that landed is not the same as
   * knowing it; panel 4 is where the unsure rate gets to speak for itself.
   */
  correctCount: number
  /** The topics this paper actually covered, most-represented first. */
  topics: { topicId: string; topicName: string; questionCount: number }[]
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
      correctCount: sql<number>`count(distinct ${attempts.id}) filter (
        where ${attempts.source} = 'markup' and ${attempts.outcome} = 'correct')::int`,
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

  /*
   * Topics in a second query rather than another join.
   *
   * `questions` and `attempts` above are a chain, so the `distinct` counts
   * survive it. `question_topics` is not part of that chain: joining it would
   * multiply every row by the topics each question is filed under, and the
   * counts already fought that battle once (see the note on the worksheets
   * page's own query). Over at most `limit` worksheets this is one small
   * indexed read.
   */
  const ids = result.map((row) => row.id)

  const topicRows = ids.length
    ? await db
        .select({
          worksheetId: questions.worksheetId,
          topicId: topics.id,
          topicName: topics.name,
          questionCount: sql<number>`count(distinct ${questions.id})::int`,
        })
        .from(questions)
        .innerJoin(
          questionTopics,
          and(
            eq(questionTopics.questionId, questions.id),
            eq(questionTopics.isPrimary, true),
          ),
        )
        .innerJoin(topics, eq(topics.id, questionTopics.topicId))
        .where(inArray(questions.worksheetId, ids))
        .groupBy(questions.worksheetId, topics.id, topics.name)
        .orderBy(desc(sql`count(distinct ${questions.id})`))
    : []

  const topicsFor = new Map<string, RecentWorksheet['topics']>()
  for (const row of topicRows) {
    const list = topicsFor.get(row.worksheetId) ?? []
    list.push({
      topicId: row.topicId,
      topicName: row.topicName,
      questionCount: Number(row.questionCount),
    })
    topicsFor.set(row.worksheetId, list)
  }

  return result.map((row) => ({
    ...row,
    questionCount: Number(row.questionCount),
    wrongCount: Number(row.wrongCount),
    markedCount: Number(row.markedCount),
    correctCount: Number(row.correctCount),
    topics: topicsFor.get(row.id) ?? [],
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
