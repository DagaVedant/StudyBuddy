import { and, eq, isNotNull, sql } from 'drizzle-orm'

import type { AIProvider, TopicCandidate } from '@/lib/ai/types'
import type { Db } from '@/lib/db/types'
import { questionTopics, questions, topics } from '@/lib/db/schema'
import { EMBEDDING_DIMENSIONS, embed } from '@/lib/embeddings'
import { pathBySlug } from '@/lib/taxonomy/trees'

export const SHORTLIST_SIZE = 25


export interface ClassifyOutcome {
  topicId: string | null

  coarse: boolean
  confidence: number
}

export function isEmbedding(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === EMBEDDING_DIMENSIONS &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  )
}

export interface ShortlistOptions {
  subjectHint?: string | null
  limit?: number
}

function subjectSubtree(subjectHint: string | null | undefined) {
  const hint = subjectHint?.trim()
  if (!hint || !pathBySlug().has(hint)) return undefined

  return sql`(${topics.slug} = ${hint} or ${topics.slug} like ${`${hint}.%`})`
}

export async function shortlistByVector(
  db: Db,
  vector: number[],
  options: ShortlistOptions = {},
): Promise<TopicCandidate[]> {
  const literal = `[${vector.join(',')}]`

  const rows = await db
    .select({ slug: topics.slug, name: topics.name })
    .from(topics)
    .where(
      and(
        eq(topics.isLeaf, true),
        isNotNull(topics.embedding),
        subjectSubtree(options.subjectHint),
      ),
    )
    .orderBy(sql`${topics.embedding} <=> ${literal}::vector`)
    .limit(options.limit ?? SHORTLIST_SIZE)

  return rows.map((row) => ({
    slug: row.slug,
    name: row.name,
    path: pathBySlug().get(row.slug) ?? row.name,
  }))
}

export class EmbeddingUnavailableError extends Error {
  constructor(cause: string) {
    super(`The embedding model could not be loaded: ${cause}`)
    this.name = 'EmbeddingUnavailableError'
  }
}

export async function shortlistTopics(
  db: Db,
  questionText: string,
  subjectHint?: string | null,
  limit = SHORTLIST_SIZE,
  questionId?: string,
): Promise<TopicCandidate[]> {
  let vector: number[]
  try {
    vector = await embed(questionText)
  } catch (error) {
    throw new EmbeddingUnavailableError((error as Error).message)
  }

  if (questionId) {
    await db.update(questions).set({ embedding: vector }).where(eq(questions.id, questionId))
  }

  return shortlistByVector(db, vector, { subjectHint, limit })
}

export async function classifyQuestion(
  db: Db,
  provider: AIProvider,
  question: { id: string; promptText: string; userId: string },
  subjectHint?: string | null,
): Promise<ClassifyOutcome> {
  const candidates = await shortlistTopics(
    db,
    question.promptText,
    subjectHint,
    undefined,
    question.id,
  )

  if (candidates.length === 0) {
    return { topicId: null, coarse: false, confidence: 0 }
  }

  const result = await provider.classifyTopic(question.promptText, candidates)

  return applyClassification(db, question, candidates, result)
}

export async function applyClassification(
  db: Db,
  question: { id: string; promptText: string; userId: string },
  candidates: TopicCandidate[],
  result: {
    topic_slug: string | null
    confidence: number
    abstain: boolean
  },
): Promise<ClassifyOutcome> {
  if (candidates.length === 0) {
    return { topicId: null, coarse: false, confidence: 0 }
  }

  const chosen =
    result.topic_slug && !result.abstain
      ? candidates.find((candidate) => candidate.slug === result.topic_slug)
      : undefined

  if (chosen) {
    const [topic] = await db
      .select({ id: topics.id })
      .from(topics)
      .where(eq(topics.slug, chosen.slug))
      .limit(1)

    if (topic) {
      await db
        .insert(questionTopics)
        .values({
          questionId: question.id,
          topicId: topic.id,
          confidence: result.confidence,
          assignedBy: 'ai',
          isPrimary: true,
        })
        .onConflictDoNothing()

      return { topicId: topic.id, coarse: false, confidence: result.confidence }
    }
  }

  return { topicId: null, coarse: true, confidence: result.confidence }
}

export async function classifyWorksheet(
  db: Db,
  provider: AIProvider,
  worksheetId: string,
  subjectHint?: string | null,
): Promise<{ classified: number; coarse: number; failed: number }> {
  const rows = await db
    .select({
      id: questions.id,
      promptText: questions.promptText,
      userId: questions.userId,
    })
    .from(questions)
    .where(eq(questions.worksheetId, worksheetId))

  const tagged = new Set(
    (
      await db
        .select({ questionId: questionTopics.questionId })
        .from(questionTopics)
        .innerJoin(questions, eq(questionTopics.questionId, questions.id))
        .where(eq(questions.worksheetId, worksheetId))
    ).map((row) => row.questionId),
  )

  let classified = 0
  let coarse = 0
  let failed = 0

  for (const question of rows) {
    if (tagged.has(question.id)) continue

    try {
      const outcome = await classifyQuestion(db, provider, question, subjectHint)
      if (outcome.topicId) classified += 1
      if (outcome.coarse) coarse += 1
    } catch (error) {
      if (error instanceof EmbeddingUnavailableError) throw error

      failed += 1
      console.error(
        `[classify] question ${question.id} could not be classified:`,
        (error as Error).message,
      )
    }
  }

  if (failed > 0) {
    console.error(
      `[classify] ${failed} of ${rows.length} question(s) on ${worksheetId} failed`,
    )
  }

  return { classified, coarse, failed }
}
