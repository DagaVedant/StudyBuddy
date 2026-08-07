import { and, eq, isNotNull, sql } from 'drizzle-orm'

import type { AIProvider, TopicCandidate } from '@/lib/ai/types'
import type { Db } from '@/lib/dashboard/queries'
import { questionTopics, questions, topicProposals, topics } from '@/lib/db/schema'
import { EMBEDDING_DIMENSIONS, embed } from '@/lib/embeddings'
import { flattenTaxonomy } from '@/lib/taxonomy/trees'

export const SHORTLIST_SIZE = 15

export const CONFIDENCE_FLOOR = 0.45

export const PROPOSAL_DEDUP_THRESHOLD = 0.85

const pathBySlug = new Map(flattenTaxonomy().map((topic) => [topic.slug, topic.path]))

export interface ClassifyOutcome {
  topicId: string | null

  coarse: boolean
  proposalId: string | null
  confidence: number
}

/**
 * Rejects anything that is not a clean vector of the right width, so a
 * caller that computed its embedding elsewhere cannot put junk into a
 * similarity query or store it against a proposal.
 */
export function isEmbedding(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === EMBEDDING_DIMENSIONS &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  )
}

/**
 * The half of shortlisting that is only ever SQL.
 *
 * Split out from shortlistTopics so it can run on a host that cannot load the
 * embedding model: whoever *can* embed (the GPU worker) computes the vector
 * and hands it here, and pgvector does the rest.
 */
export async function shortlistByVector(
  db: Db,
  vector: number[],
  subjectHint?: string | null,
  limit = SHORTLIST_SIZE,
): Promise<TopicCandidate[]> {
  const literal = `[${vector.join(',')}]`

  const rows = await db
    .select({ id: topics.id, slug: topics.slug, name: topics.name })
    .from(topics)
    .where(
      and(
        eq(topics.isLeaf, true),
        eq(topics.isCanonical, true),
        isNotNull(topics.embedding),
        subjectHint
          ? sql`${topics.slug} like ${`${subjectHint.split('.')[0]}%`}`
          : undefined,
      ),
    )
    .orderBy(sql`${topics.embedding} <=> ${literal}::vector`)
    .limit(limit)

  return rows.map((row) => ({
    slug: row.slug,
    name: row.name,
    path: pathBySlug.get(row.slug) ?? row.name,
  }))
}

/**
 * Embeds here and then searches — so this only works where the model can
 * load. Callers on a host without it (Vercel) should take the vector from
 * somewhere that can, via shortlistByVector.
 *
 * A failure to embed returns no candidates rather than throwing, which
 * callers already treat as "leave the question untagged". Logged, not
 * swallowed: every question going untagged is an empty dashboard, not a
 * normal outcome.
 */
export async function shortlistTopics(
  db: Db,
  questionText: string,
  subjectHint?: string | null,
  limit = SHORTLIST_SIZE,
): Promise<TopicCandidate[]> {
  let vector: number[]
  try {
    vector = await embed(questionText)
  } catch (error) {
    console.error(
      '[classify] embedding unavailable, leaving question untagged:',
      (error as Error).message,
    )
    return []
  }

  return shortlistByVector(db, vector, subjectHint, limit)
}

async function nearestAncestor(db: Db, slug: string): Promise<string | null> {
  const parts = slug.split('.')

  while (parts.length > 1) {
    parts.pop()
    const [row] = await db
      .select({ id: topics.id })
      .from(topics)
      .where(eq(topics.slug, parts.join('.')))
      .limit(1)

    if (row) return row.id
  }

  return null
}

export async function classifyQuestion(
  db: Db,
  provider: AIProvider,
  question: { id: string; promptText: string; userId: string },
  subjectHint?: string | null,
): Promise<ClassifyOutcome> {
  const candidates = await shortlistTopics(db, question.promptText, subjectHint)

  if (candidates.length === 0) {
    return { topicId: null, coarse: false, proposalId: null, confidence: 0 }
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
    suggested_name: string | null
  },
  // Only consulted when the result turns out coarse, which is the one branch
  // that raises a proposal. Passed in by callers that cannot embed locally.
  proposalEmbedding?: number[],
): Promise<ClassifyOutcome> {
  if (candidates.length === 0) {
    return { topicId: null, coarse: false, proposalId: null, confidence: 0 }
  }

  const chosen =
    result.topic_slug && !result.abstain
      ? candidates.find((candidate) => candidate.slug === result.topic_slug)
      : undefined

  const confident = result.confidence >= CONFIDENCE_FLOOR

  if (chosen && confident) {
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

      return {
        topicId: topic.id,
        coarse: false,
        proposalId: null,
        confidence: result.confidence,
      }
    }
  }

  const ancestorId = await nearestAncestor(db, candidates[0].slug)

  if (ancestorId) {
    await db
      .insert(questionTopics)
      .values({
        questionId: question.id,
        topicId: ancestorId,
        confidence: result.confidence,
        assignedBy: 'ai',
        isPrimary: true,
      })
      .onConflictDoNothing()
  }

  const proposalId = await proposeTopic(db, {
    name: result.suggested_name ?? question.promptText.slice(0, 80),
    questionId: question.id,
    userId: question.userId,
    parentId: ancestorId,
    embedding: proposalEmbedding,
  })

  return {
    topicId: ancestorId,
    coarse: true,
    proposalId,
    confidence: result.confidence,
  }
}

export async function proposeTopic(
  db: Db,
  input: {
    name: string
    questionId: string | null
    userId: string | null
    parentId: string | null
    // Supplied by callers that computed it elsewhere; otherwise embedded here.
    embedding?: number[]
  },
): Promise<string | null> {
  const name = input.name.trim().slice(0, 120)
  if (!name) return null

  const vector = input.embedding ?? (await embed(name))
  const literal = `[${vector.join(',')}]`

  const [nearProposal] = await db
    .select({
      id: topicProposals.id,
      distance: sql<number>`${topicProposals.embedding} <=> ${literal}::vector`,
    })
    .from(topicProposals)
    .where(
      and(eq(topicProposals.status, 'pending'), isNotNull(topicProposals.embedding)),
    )
    .orderBy(sql`${topicProposals.embedding} <=> ${literal}::vector`)
    .limit(1)

  if (nearProposal && 1 - Number(nearProposal.distance) >= PROPOSAL_DEDUP_THRESHOLD) {
    return nearProposal.id
  }

  const [row] = await db
    .insert(topicProposals)
    .values({
      proposedName: name,
      suggestedParentId: input.parentId,
      sourceQuestionId: input.questionId,
      userId: input.userId,
      embedding: vector,
      status: 'pending',
    })
    .returning({ id: topicProposals.id })

  return row.id
}

export async function classifyWorksheet(
  db: Db,
  provider: AIProvider,
  worksheetId: string,
  subjectHint?: string | null,
): Promise<{ classified: number; coarse: number }> {
  const rows = await db
    .select({
      id: questions.id,
      promptText: questions.promptText,
      userId: questions.userId,
    })
    .from(questions)
    .where(eq(questions.worksheetId, worksheetId))

  let classified = 0
  let coarse = 0

  for (const question of rows) {
    const existing = await db
      .select({ topicId: questionTopics.topicId })
      .from(questionTopics)
      .where(eq(questionTopics.questionId, question.id))
      .limit(1)

    if (existing.length > 0) continue

    try {
      const outcome = await classifyQuestion(db, provider, question, subjectHint)
      if (outcome.topicId) classified += 1
      if (outcome.coarse) coarse += 1
    } catch {

    }
  }

  return { classified, coarse }
}
