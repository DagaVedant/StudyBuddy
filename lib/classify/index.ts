import { and, eq, isNotNull, sql } from 'drizzle-orm'

import type { AIProvider, TopicCandidate } from '@/lib/ai/types'
import type { Db } from '@/lib/db/types'
import { questionTopics, questions, topicProposals, topics } from '@/lib/db/schema'
import { EMBEDDING_DIMENSIONS, embed } from '@/lib/embeddings'
import { flattenTaxonomy } from '@/lib/taxonomy/trees'

/**
 * How many leaf topics the model gets to choose between.
 *
 * Set by measurement, not by taste. Against the hand-labelled set in
 * scripts/topic-labels.ts, run by scripts/shortlist-recall.ts, a shortlist
 * of 15 puts a defensible topic in front of the model for 21 of 29 questions.
 * The other 8 were never winnable: the model cannot pick what it is not shown,
 * and every confidence threshold and prompt rewrite in the world operates on
 * the list after this number has decided what is in it.
 *
 *   recall@15  72%    recall@25  86%    recall@50  93%
 *
 * 25 is where it stops paying: 30 and 40 measure identically, and 50 buys two
 * more questions for twice the prompt.
 */
export const SHORTLIST_SIZE = 25

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

export interface ShortlistOptions {
  /** Restricts the search to one subject root, e.g. `high-school-math`. */
  subjectHint?: string | null
  /** How many candidates the model is shown. Defaults to {@link SHORTLIST_SIZE}. */
  limit?: number
}

/**
 * The half of shortlisting that is only ever SQL.
 *
 * Split out from shortlistTopics so it can run on a host that cannot load the
 * embedding model: whoever *can* embed (the GPU worker) computes the vector
 * and hands it here, and pgvector does the rest.
 *
 * Plain nearest neighbour, deliberately. The obvious repair for a shortlist
 * that fills all its places with one branch of the taxonomy — "in how many
 * ways can 6 people be seated around a circular table" returns geometry,
 * because "circular table" embeds towards circles — is to cap how many any one
 * branch may contribute. Measured, that is worse, not better: at three per
 * branch recall@15 falls from 72 % to 66 %, and at two to 59 %, because the
 * cap evicts the fourth and fifth candidates from the branch that was right
 * and spends those places on branches that were never in the running. The
 * shortlist is too blunt an instrument for that; what it responds to is being
 * longer.
 */
export async function shortlistByVector(
  db: Db,
  vector: number[],
  options: ShortlistOptions = {},
): Promise<TopicCandidate[]> {
  const literal = `[${vector.join(',')}]`
  const subjectHint = options.subjectHint

  const rows = await db
    .select({ slug: topics.slug, name: topics.name })
    .from(topics)
    .where(
      and(
        eq(topics.isLeaf, true),
        // Deliberately not filtered on `isCanonical`. That flag records where a
        // topic came from, so a re-seed knows what it may overwrite, and using
        // it here quietly excluded every topic an admin had ever accepted:
        // `acceptTopicProposal` creates them non-canonical, carries the
        // embedding across so they are matchable, and then nothing could match
        // them. Accepting a proposal shrank the set classification could choose
        // from, and the next question that did not fit raised the same proposal
        // again, which is the loop accepting one is supposed to end.
        isNotNull(topics.embedding),
        subjectHint ? sql`${topics.slug} like ${`${subjectHint.split('.')[0]}%`}` : undefined,
      ),
    )
    .orderBy(sql`${topics.embedding} <=> ${literal}::vector`)
    .limit(options.limit ?? SHORTLIST_SIZE)

  return rows.map((row) => ({
    slug: row.slug,
    name: row.name,
    path: pathBySlug.get(row.slug) ?? row.name,
  }))
}

/**
 * The embedding model could not be loaded at all.
 *
 * Distinct from "this question matched nothing", which is an ordinary outcome.
 * This one means every question on every worksheet will go untagged for as long
 * as it lasts, so it has to reach a caller that can say so rather than being
 * counted as a shortlist of zero.
 */
export class EmbeddingUnavailableError extends Error {
  constructor(cause: string) {
    super(`The embedding model could not be loaded: ${cause}`)
    this.name = 'EmbeddingUnavailableError'
  }
}

/**
 * Embeds here and then searches, so this only works where the model can
 * load. Callers on a host without it (Vercel) should take the vector from
 * somewhere that can, via shortlistByVector.
 *
 * Throws when the model will not load, and used to return `[]` instead. That
 * read to every caller as "no candidates", which is what an unclassifiable
 * question looks like, so a host that could not load onnxruntime at all
 * produced a worksheet where every question was untagged and a job that
 * reported success. The dashboard is empty and nothing anywhere is an error.
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
    throw new EmbeddingUnavailableError((error as Error).message)
  }

  return shortlistByVector(db, vector, { subjectHint, limit })
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

  // `confidence` is not gated on. It is a number a 7B model writes about its
  // own work, and across the 288 questions of the Edison run nothing came back
  // below 0.75 — the floor of 0.45 this used to test never once fired, so the
  // abstain path it was guarding was unreachable, and every wrong tag in that
  // run arrived over the line. It is still stored, because it is worth being
  // able to look at; it is no longer treated as evidence.
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

      return {
        topicId: topic.id,
        coarse: false,
        proposalId: null,
        confidence: result.confidence,
      }
    }
  }

  // Nothing is tagged from here down. The model either abstained or named a
  // slug that is not on the list, and what used to happen then was that the
  // question was given the parent of `candidates[0]` — the nearest *embedding*
  // match, which is to say the thing the model had just been shown and
  // declined. Nineteen questions were tagged that way in the last run, several
  // at confidence 1.00, and the system prompt tells the model in as many words
  // that a wrong-but-plausible tag is worse than none because it corrupts the
  // weakness report. Overriding the abstain it asked for made the prompt a
  // lie. An untagged question shows up as untagged; a wrongly tagged one is
  // invisible and wrong.
  //
  // The nearest ancestor is still worked out, because a proposal needs
  // somewhere to hang.
  const ancestorId = await nearestAncestor(db, candidates[0].slug)

  const proposalId = await proposeTopic(db, {
    name: result.suggested_name ?? question.promptText.slice(0, 80),
    questionId: question.id,
    userId: question.userId,
    parentId: ancestorId,
    embedding: proposalEmbedding,
  })

  return {
    topicId: null,
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
): Promise<{ classified: number; coarse: number; failed: number }> {
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
  let failed = 0

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
    } catch (error) {
      // Not survivable and not worth trying 113 more times. Every remaining
      // question would fail the same way, and the caller needs to know the
      // difference between "the model declined to tag these" and "there is no
      // model on this host".
      if (error instanceof EmbeddingUnavailableError) throw error

      // One question failing is survivable: the model returned something
      // unusable, or the row is malformed. It used to be swallowed in silence,
      // which is how a worksheet came back with a third of its questions
      // untagged and nothing to explain why.
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
