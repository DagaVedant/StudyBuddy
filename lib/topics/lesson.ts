import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm'

import type { AIProvider } from '@/lib/ai/types'
import { questionTopics, questions, topicLessons, topics } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'
import { pathBySlug } from '@/lib/taxonomy/trees'
import { trimLessonBody } from './lesson-body'

/**
 * How many real questions the lesson writer is shown.
 *
 * Enough to pitch the lesson at the level the topic is actually tested at, and
 * no more. "Circles" means something different on an AMC 8 paper and a Year 7
 * worksheet, and a lesson written from the topic name alone lands on neither.
 */
const SAMPLE_QUESTIONS = 5

export interface StoredLesson {
  bodyMd: string
  examples: { question: string; working: string; answer: string }[]
  commonErrors: { mistake: string; why: string; fix: string }[]
  model: string | null
  generatedAt: Date
}

/** The lesson for this topic, or null if nobody has written one yet. */
export async function getLesson(db: Db, topicId: string): Promise<StoredLesson | null> {
  const [row] = await db
    .select({
      bodyMd: topicLessons.bodyMd,
      examples: topicLessons.examples,
      commonErrors: topicLessons.commonErrors,
      model: topicLessons.model,
      generatedAt: topicLessons.generatedAt,
    })
    .from(topicLessons)
    .where(eq(topicLessons.topicId, topicId))
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

/**
 * Writes the lesson for one topic, if it does not already have one.
 *
 * Keyed on the topic and shared by everybody who reaches it, which is what
 * makes this affordable: 276 leaves in the taxonomy against an unbounded number
 * of students. Nothing here is personal, and the prompt forbids the model from
 * addressing the reader's own results, because cached prose saying "you got
 * three of eight wrong" is wrong for the next reader. Their own missed
 * questions sit beside the lesson on the page, assembled from their attempts.
 *
 * Returns null when the topic already has one, so a caller can run this over
 * the whole taxonomy and only pay for what is missing.
 */
export async function generateLesson(
  db: Db,
  provider: AIProvider,
  topicId: string,
  options: { force?: boolean } = {},
): Promise<StoredLesson | null> {
  if (!options.force) {
    const existing = await getLesson(db, topicId)
    if (existing) return null
  }

  const [topic] = await db
    .select({ name: topics.name, slug: topics.slug })
    .from(topics)
    .where(eq(topics.id, topicId))
    .limit(1)

  if (!topic) throw new Error(`No topic ${topicId}`)

  const lesson = await provider.teachTopic({
    topicName: topic.name,
    topicPath: pathBySlug().get(topic.slug) ?? topic.name,
    samples: await sampleQuestions(db, topicId),
  })

  const values = {
    topicId,
    // Trimmed rather than trusted. The prompt forbids the body carrying its
    // own examples and pitfalls, and three rewordings of that instruction did
    // not stop it happening; the page renders both separately.
    bodyMd: trimLessonBody(lesson.body_md),
    examples: lesson.examples,
    commonErrors: lesson.common_errors,
    provider: null,
    // The model that wrote it, which on a split configuration is not the
    // provider's text model. This string is printed to the reader.
    model: provider.answeringModel,
  }

  await db
    .insert(topicLessons)
    .values(values)
    .onConflictDoUpdate({ target: topicLessons.topicId, set: values })

  return {
    bodyMd: values.bodyMd,
    examples: lesson.examples,
    commonErrors: lesson.common_errors,
    model: provider.answeringModel,
    generatedAt: new Date(),
  }
}

/**
 * A few real questions tagged with this topic, longest first.
 *
 * Longest rather than newest, because a one-line question says least about the
 * level being tested. These go into the prompt as context and the model is told
 * to teach the topic rather than these, which is the same rule the page-seam
 * context carries in extraction.
 */
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

/**
 * Topics worth writing a lesson for, weakest first.
 *
 * Only topics somebody has actually answered questions in. There are 276 leaves
 * and most of them will never be seen by this install's students, so generating
 * the whole tree would spend hours of GPU on lessons nobody opens.
 */
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
      // Skipping written topics is the whole point of this normally, and it is
      // also what made `--force` a no-op: the flag reached `generateLesson`,
      // which was never handed a topic to overwrite, so a run meant to rewrite
      // five lessons quietly wrote five different ones instead.
      options.includeWritten
        ? sql`true`
        : sql`not exists (select 1 from ${topicLessons} where ${topicLessons.topicId} = ${topics.id})`,
    )
    .groupBy(topics.id, topics.name)
    .orderBy(desc(sql`count(*)`), asc(topics.name))
    .limit(limit)

  return rows
}
