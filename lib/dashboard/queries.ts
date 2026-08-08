import { and, desc, eq, gte, lte, sql } from 'drizzle-orm'

import { unwrapDriverRows as rows } from '@/lib/db/rows'
import {
  attempts,
  questionTopics,
  questions,
  reviewCards,
  topics,
  worksheets,
} from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'

import type { TopicStats } from './ranking'

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
  dueNow: number
  dueThisWeek: number
  attemptsLogged: number
}

export async function getOverview(db: Db, userId: string): Promise<Overview> {
  const now = new Date()
  const weekOut = new Date(now.getTime() + 7 * 24 * 3600_000)

  const [counts] = rows<{
    questions_tracked: number
    worksheets_uploaded: number
    attempts_logged: number
  }>(
    await db.execute(sql`
      select
        (select count(*) from ${questions} where ${questions.userId} = ${userId})::int
          as questions_tracked,
        (select count(*) from ${worksheets} where ${worksheets.userId} = ${userId})::int
          as worksheets_uploaded,
        (select count(*) from ${attempts} where ${attempts.userId} = ${userId})::int
          as attempts_logged
    `),
  )

  const [dueNow] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(reviewCards)
    .where(and(eq(reviewCards.userId, userId), lte(reviewCards.dueAt, now)))

  const [dueWeek] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(reviewCards)
    .where(and(eq(reviewCards.userId, userId), lte(reviewCards.dueAt, weekOut)))

  return {
    questionsTracked: Number(counts?.questions_tracked ?? 0),
    worksheetsUploaded: Number(counts?.worksheets_uploaded ?? 0),
    attemptsLogged: Number(counts?.attempts_logged ?? 0),
    dueNow: Number(dueNow?.value ?? 0),
    dueThisWeek: Number(dueWeek?.value ?? 0),
  }
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
  const since = new Date(Date.now() - weeks * 7 * 24 * 3600_000)

  const result = await db
    .select({
      weekStart: sql<string>`to_char(date_trunc('week', ${attempts.createdAt}), 'YYYY-MM-DD')`,
      correct: sql<number>`count(*) filter (where ${attempts.outcome} = 'correct')::int`,
      unsure: sql<number>`count(*) filter (where ${attempts.outcome} = 'unsure')::int`,
      wrong: sql<number>`count(*) filter (where ${attempts.outcome} = 'wrong')::int`,
    })
    .from(attempts)
    .where(and(eq(attempts.userId, userId), gte(attempts.createdAt, since)))
    .groupBy(sql`date_trunc('week', ${attempts.createdAt})`)
    .orderBy(sql`date_trunc('week', ${attempts.createdAt})`)

  return result.map((row) => ({
    weekStart: row.weekStart,
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
      questionCount: sql<number>`count(distinct ${questions.id})::int`,
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
