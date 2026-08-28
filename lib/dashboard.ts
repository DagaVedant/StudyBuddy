import {and, asc, desc, eq, inArray, isNotNull, lte, sql} from 'drizzle-orm'

import {COUNTS_TOWARDS_ACCURACY, IS_QUESTION} from '@/lib/questions/queries'
import {inReviewQueue} from '@/lib/review'
import {type Db, unwrapDriverRows as rows} from '@/lib/db'
import {type TopicStats} from '@/lib/ranking'
import {MIN_ATTEMPTS} from '@/lib/upload'
import {attempts, questionTopics, questions, reviewCards, topics, worksheets} from '@/lib/schema'

const TREND_BAND = 0.1

export async function getTopicStats(db: Db, userId: string): Promise<TopicStats[]> {
  const answered = await db
    .select({
      topicId: topics.id,
      topicName: topics.name,
      slug: topics.slug,
      subjectRoot: topics.subjectRoot,
      outcome: attempts.outcome,
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
    .where(and(eq(attempts.userId, userId), COUNTS_TOWARDS_ACCURACY))
    .orderBy(asc(attempts.createdAt), asc(attempts.id))

  type Bucket = {
    topicId: string
    topicName: string
    topicPath: string
    subjectRoot: string
    outcomes: string[]
  }

  let byTopic = new Map<string, Bucket>()

  for (let row of answered) {
    let bucket = byTopic.get(row.topicId)

    if (!bucket) {
      bucket = {
        topicId: row.topicId,
        topicName: row.topicName,
        topicPath: row.slug,
        subjectRoot: row.subjectRoot,
        outcomes: [],
      }

      byTopic.set(row.topicId, bucket)
    }

    bucket.outcomes.push(row.outcome)
  }

  let out: TopicStats[] = []

  for (let bucket of byTopic.values()) {
    let correct = 0
    let unsure = 0
    let wrong = 0

    for (let outcome of bucket.outcomes) {
      if (outcome === 'correct') correct = correct + 1
      if (outcome === 'unsure') unsure = unsure + 1
      if (outcome === 'wrong') wrong = wrong + 1
    }

    let total = bucket.outcomes.length
    let half = total / 2

    let earlierRight = 0
    let earlierSeen = 0
    let recentRight = 0
    let recentSeen = 0

    for (let i = 0; i < total; i++) {
      let right = 1
      if (bucket.outcomes[i] === 'wrong') right = 0

      if (i + 1 <= half) {
        earlierRight = earlierRight + right
        earlierSeen = earlierSeen + 1
      } else {
        recentRight = recentRight + right
        recentSeen = recentSeen + 1
      }
    }

    let earlier = null
    if (earlierSeen > 0) earlier = earlierRight / earlierSeen

    let recent = null
    if (recentSeen > 0) recent = recentRight / recentSeen

    out.push({
      topicId: bucket.topicId,
      topicName: bucket.topicName,
      topicPath: bucket.topicPath,
      subjectRoot: bucket.subjectRoot,
      correct: correct,
      unsure: unsure,
      wrong: wrong,
      trend: trendOf(earlier, recent),
    })
  }

  return out
}

function trendOf(earlier: number | null, recent: number | null): string | null {
  if (earlier === null || recent === null) return null

  const move = recent - earlier
  if (move > TREND_BAND) return 'up'
  if (move < -TREND_BAND) return 'down'
  return 'flat'
}

export type Overview = {
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

export type UntaggedWorksheet = {
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

export type RecentWorksheet = {
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
    let list = topicsFor.get(row.worksheetId)

    if (!list) {
      list = []
      topicsFor.set(row.worksheetId, list)
    }

    list.push({
      topicId: row.topicId,
      topicName: row.topicName,
      questionCount: Number(row.questionCount),
    })
  }

  const recent: RecentWorksheet[] = []

  for (const row of result) {
    let topics = topicsFor.get(row.id)
    if (!topics) topics = []

    recent.push({
      ...row,
      questionCount: Number(row.questionCount),
      wrongCount: Number(row.wrongCount),
      markedCount: Number(row.markedCount),
      correctCount: Number(row.correctCount),
      topics,
    })
  }

  return recent
}

export type DistractorPattern = {
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

export type AccountAccuracy = {
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
