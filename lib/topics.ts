import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'

import type { AIProvider, Lesson, LessonInput } from '@/lib/ai/types'
import { questionTopics, questions, topicLessons, topics } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'
import { pathBySlug } from '@/lib/taxonomy'

const SAMPLE_QUESTIONS = 5

export interface StoredLesson {
  bodyMd: string
  examples: { question: string; working: string; answer: string }[]
  commonErrors: { mistake: string; why: string; fix: string }[]
  model: string | null
  generatedAt: Date
}

function ownedBy(userId: string | null) {
  return userId === null
    ? isNull(topicLessons.userId)
    : eq(topicLessons.userId, userId)
}

async function lessonFor(
  db: Db,
  topicId: string,
  userId: string | null,
): Promise<StoredLesson | null> {
  const [row] = await db
    .select({
      bodyMd: topicLessons.bodyMd,
      examples: topicLessons.examples,
      commonErrors: topicLessons.commonErrors,
      model: topicLessons.model,
      generatedAt: topicLessons.generatedAt,
    })
    .from(topicLessons)
    .where(and(eq(topicLessons.topicId, topicId), ownedBy(userId)))
    .limit(1)

  if (!row) return null

  return {
    bodyMd: row.bodyMd,
    examples: row.examples ?? [],
    commonErrors: row.commonErrors ?? [],
    model: row.model,
    generatedAt: row.generatedAt,
  }
}

export async function getOwnLesson(
  db: Db,
  topicId: string,
  userId: string,
): Promise<StoredLesson | null> {
  return lessonFor(db, topicId, userId)
}

export async function getLesson(
  db: Db,
  topicId: string,
  userId: string | null,
): Promise<StoredLesson | null> {
  const canonical = await lessonFor(db, topicId, null)
  if (canonical || userId === null) return canonical

  return lessonFor(db, topicId, userId)
}

export async function lessonInput(db: Db, topicId: string): Promise<LessonInput> {
  const [topic] = await db
    .select({ name: topics.name, slug: topics.slug })
    .from(topics)
    .where(eq(topics.id, topicId))
    .limit(1)

  if (!topic) throw new Error(`No topic ${topicId}`)

  return {
    topicName: topic.name,
    topicPath: pathBySlug().get(topic.slug) ?? topic.name,
    samples: await sampleQuestions(db, topicId),
  }
}

export async function storeLesson(
  db: Db,
  topicId: string,
  userId: string | null,
  lesson: Lesson,
  model: string | null,
): Promise<StoredLesson> {
  const values = {
    topicId,
    userId,
    bodyMd: trimLessonBody(lesson.body_md),
    examples: lesson.examples,
    commonErrors: lesson.common_errors,
    provider: null,
    model,
  }

  const conflict =
    userId === null
      ? {
          target: topicLessons.topicId,
          targetWhere: isNull(topicLessons.userId),
        }
      : {
          target: [topicLessons.topicId, topicLessons.userId],
          targetWhere: isNotNull(topicLessons.userId),
        }

  await db
    .insert(topicLessons)
    .values(values)
    .onConflictDoUpdate({ ...conflict, set: values })

  return {
    bodyMd: values.bodyMd,
    examples: lesson.examples,
    commonErrors: lesson.common_errors,
    model,
    generatedAt: new Date(),
  }
}

export async function generateLesson(
  db: Db,
  provider: AIProvider,
  topicId: string,
  options: { force?: boolean } = {},
): Promise<StoredLesson | null> {
  if (!options.force) {
    const existing = await getLesson(db, topicId, null)
    if (existing) return null
  }

  const lesson = await provider.teachTopic(await lessonInput(db, topicId))

  return storeLesson(db, topicId, null, lesson, provider.answeringModel)
}

async function sampleQuestions(db: Db, topicId: string): Promise<string[]> {
  const rows = await db
    .select({ promptText: questions.promptText })
    .from(questions)
    .innerJoin(questionTopics, eq(questionTopics.questionId, questions.id))
    .where(and(eq(questionTopics.topicId, topicId), isNotNull(questions.promptText)))
    .orderBy(desc(sql`length(${questions.promptText})`))
    .limit(SAMPLE_QUESTIONS)

  return rows.map((row) => row.promptText)
}

export async function topicsNeedingLessons(
  db: Db,
  limit = 20,
  options: { includeWritten?: boolean } = {},
): Promise<{ topicId: string; name: string; attempts: number }[]> {
  const rows = await db
    .select({
      topicId: topics.id,
      name: topics.name,
      attempts: sql<number>`count(*)::int`,
    })
    .from(questionTopics)
    .innerJoin(topics, eq(topics.id, questionTopics.topicId))
    .where(
      options.includeWritten
        ? sql`true`
        : sql`not exists (
            select 1 from ${topicLessons}
            where ${topicLessons.topicId} = ${topics.id}
              and ${topicLessons.userId} is null
          )`,
    )
    .groupBy(topics.id, topics.name)
    .orderBy(desc(sql`count(*)`), asc(topics.name))
    .limit(limit)

  return rows
}

const SECTION_START = /^(#{1,6})\s+(.*)$|^\*\*([^*]+)\*\*:?\s*$/

const DUPLICATED =
  /^(some\s+|a\s+few\s+|other\s+)?(worked\s+|sample\s+|practice\s+)?(examples?|common\s+(errors?|mistakes?|pitfalls?)|errors?|mistakes?|pitfalls?|traps?|things\s+to\s+(avoid|watch\s+(out\s+)?for)|watch\s+outs?|what\s+(people|students)\s+get\s+wrong)\b/i

interface Section {
  title: string
  level: number
}

function sectionOf(line: string): Section | null {
  const match = SECTION_START.exec(line.trim())
  if (!match) return null

  if (match[3] !== undefined) return { title: match[3].trim(), level: 99 }

  return { title: (match[2] ?? '').trim(), level: match[1].length }
}

export function trimLessonBody(bodyMd: string): string {
  const lines = bodyMd.replace(/\r\n/g, '\n').split('\n')
  const kept: string[] = []

  let skipping = false

  for (const line of lines) {
    const section = sectionOf(line)

    if (section) {
      if (section.level === 1 && !DUPLICATED.test(section.title)) {
        skipping = false
        continue
      }

      skipping = DUPLICATED.test(section.title)
      if (skipping) continue
    }

    if (!skipping) kept.push(line)
  }

  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
