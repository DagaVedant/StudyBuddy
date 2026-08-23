import {and, desc, eq, inArray, isNotNull, lte, sql} from 'drizzle-orm'

import {COUNTS_TOWARDS_ACCURACY, IS_QUESTION} from '@/lib/questions/queries'
import {inReviewQueue} from '@/lib/review'
import {type Db, unwrapDriverRows as rows} from '@/lib/db'
import {type TopicStats} from '@/lib/ranking'
import {MIN_ATTEMPTS} from '@/lib/upload'
import {attempts, questionTopics, questions, reviewCards, topics, worksheets} from '@/lib/schema'

const TREND_BAND = 0.1

export async function getTopicStats(db: Db, userId: string): Promise<TopicStats[]> {
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
        where ${attempts.userId} = ${userId} and ${COUNTS_TOWARDS_ACCURACY}
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
  dueNow: number
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
          where ${questions.userId} = ${userId}
            and ${questions.origin} = 'extracted' and ${IS_QUESTION})::int
          as questions_tracked,
        (select count(*) from ${worksheets}
          where ${worksheets.userId} = ${userId}
            and ${worksheets.origin} = 'extracted')::int
          as worksheets_uploaded,
        (select count(*) from ${attempts} where ${attempts.userId} = ${userId})::int
          as attempts_logged
    `),
  )

  const [dueNow] = await db
    .select({value: sql<number>`count(*)::int`})
    .from(reviewCards)
    .where(
      and(
        eq(reviewCards.userId, userId),
        inReviewQueue(userId),
        lte(reviewCards.dueAt, now),
      ),
    )

  const [queued] = await db
    .select({value: sql<number>`count(*)::int`})
    .from(reviewCards)
    .where(and(eq(reviewCards.userId, userId), inReviewQueue(userId)))

  return {
    questionsTracked: Number(counts.questions_tracked),
    worksheetsUploaded: Number(counts.worksheets_uploaded),
    attemptsLogged: Number(counts.attempts_logged),
    dueNow: Number(dueNow.value),
    toPractise: Number(queued.value),
  }
}

const UNTAGGED_WORKSHEETS_SHOWN = 20

export interface UntaggedWorksheet {
  id: string
  title: string
}

export async function listUntaggedWorksheets(
  db: Db,
  userId: string,
  limit = UNTAGGED_WORKSHEETS_SHOWN,
): Promise<UntaggedWorksheet[]> {
  return db
    .select({id: worksheets.id, title: worksheets.title})
    .from(worksheets)
    .where(
      and(eq(worksheets.userId, userId), isNotNull(worksheets.classificationError)),
    )
    .orderBy(desc(worksheets.createdAt))
    .limit(limit)
}

export interface TrendPoint {
  weekStart: string
  correct: number
  unsure: number
  wrong: number
}

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
        and exists (
          select 1 from ${questions} scored
          where scored.id = a.question_id and scored.origin = 'extracted'
        )
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
        join ${questions} q on q.id = a.question_id and q.origin = 'extracted'
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
    .map(([subjectRoot, points]) => ({subjectRoot, points}))
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
  markedCount: number
  correctCount: number
  topics: {topicId: string; topicName: string; questionCount: number}[]
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
      questionCount: sql<number>`count(distinct ${questions.id}) filter (where ${IS_QUESTION})::int`,
      wrongCount: sql<number>`count(distinct ${attempts.id}) filter (where ${attempts.outcome} = 'wrong')::int`,
      markedCount: sql<number>`count(distinct ${attempts.id}) filter (where ${attempts.source} = 'markup')::int`,
      correctCount: sql<number>`count(distinct ${attempts.id}) filter (
        where ${attempts.source} = 'markup' and ${attempts.outcome} = 'correct')::int`,
    })
    .from(worksheets)
    .leftJoin(questions, eq(questions.worksheetId, worksheets.id))
    .leftJoin(attempts, eq(attempts.questionId, questions.id))
    .where(and(eq(worksheets.userId, userId), eq(worksheets.origin, 'extracted')))
    .groupBy(
      worksheets.id,
      worksheets.title,
      worksheets.status,
      worksheets.pageCount,
      worksheets.createdAt,
    )
    .orderBy(desc(worksheets.createdAt))
    .limit(limit)

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
      join questions q on q.id = a.question_id and q.origin = 'extracted'
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

export async function getAccountAccuracy(db: Db, userId: string): Promise<AccountAccuracy> {
  const [row] = rows<{correct: number; total: number}>(
    await db.execute(sql`
      select
        count(*) filter (where ${attempts.outcome} = 'correct')::int as correct,
        count(*)::int as total
      from ${attempts}
      where ${attempts.userId} = ${userId} and ${COUNTS_TOWARDS_ACCURACY}
    `),
  )

  const {correct, total} = row

  return {
    correct,
    attempts: total,
    accuracy: total > 0 ? correct / total : 0,
    ranked: total >= MIN_ATTEMPTS,
  }
}

export async function getStudyStreak(db: Db, userId: string): Promise<number> {
  const now = new Date()

  const days = rows<{day: string}>(
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

export type StudyDay = {
  day: string
  total: number
  correct: number
  wrong: number
}

export async function getStudyCalendar(
  db: Db,
  userId: string,
  days = 182,
): Promise<StudyDay[]> {
  const result = rows<{
    day: string
    total: number
    correct: number
    wrong: number
  }>(
    await db.execute(sql`
      select
        to_char(date_trunc('day', ${attempts.createdAt}), 'YYYY-MM-DD') as day,
        count(*)::int as total,
        count(*) filter (where ${attempts.outcome} = 'correct')::int as correct,
        count(*) filter (where ${attempts.outcome} = 'wrong')::int as wrong
      from ${attempts}
      where ${attempts.userId} = ${userId}
        and ${attempts.createdAt} >= now() - make_interval(days => ${days})
      group by 1
      order by 1
    `),
  )

  return result.map((row) => ({
    day: row.day,
    total: Number(row.total),
    correct: Number(row.correct),
    wrong: Number(row.wrong),
  }))
}
