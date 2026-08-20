import { eq, inArray } from 'drizzle-orm'

import { type Db, isUniqueViolation } from '@/lib/db/types'
import { questionTopics, topicProposals, topics } from '@/lib/db/schema'

export type AcceptOutcome =
  | { ok: true; topicId: string; slug: string; taggedSource: boolean }
  | { ok: false; reason: 'not_found' | 'not_pending' | 'no_parent' }

export async function acceptTopicProposal(
  db: Db,
  proposalId: string,
): Promise<AcceptOutcome> {
  const [proposal] = await db
    .select()
    .from(topicProposals)
    .where(eq(topicProposals.id, proposalId))
    .limit(1)

  if (!proposal) return { ok: false, reason: 'not_found' }
  if (proposal.status !== 'pending') return { ok: false, reason: 'not_pending' }

  if (!proposal.suggestedParentId) return { ok: false, reason: 'no_parent' }

  const [parent] = await db
    .select()
    .from(topics)
    .where(eq(topics.id, proposal.suggestedParentId))
    .limit(1)

  if (!parent) return { ok: false, reason: 'no_parent' }

  const wanted = `${parent.slug}.${slugify(proposal.proposedName)}`

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await accept(db, proposal, parent, wanted)
    } catch (error) {
      if (!isUniqueViolation(error) || attempt >= SLUG_ATTEMPTS) throw error

      console.warn(
        `[proposals] slug collision on ${wanted}, attempt ${attempt}; retrying`,
      )
    }
  }
}

const SLUG_ATTEMPTS = 3

async function accept(
  db: Db,
  proposal: typeof topicProposals.$inferSelect,
  parent: typeof topics.$inferSelect,
  wanted: string,
): Promise<AcceptOutcome> {
  return db.transaction(async (tx) => {
    const slug = await uniqueSlug(tx, wanted)

    const [created] = await tx
      .insert(topics)
      .values({
        parentId: parent.id,
        slug,
        name: proposal.proposedName,
        depth: parent.depth + 1,
        subjectRoot: parent.subjectRoot,
        isCanonical: false,
        isLeaf: true,
        embedding: proposal.embedding,
      })
      .returning({ id: topics.id })

    if (parent.isLeaf) {
      await tx.update(topics).set({ isLeaf: false }).where(eq(topics.id, parent.id))
    }

    let taggedSource = false

    if (proposal.sourceQuestionId) {
      await tx
        .insert(questionTopics)
        .values({
          questionId: proposal.sourceQuestionId,
          topicId: created.id,
          confidence: 1,
          assignedBy: 'user',
          isPrimary: true,
        })
        .onConflictDoNothing()

      taggedSource = true
    }

    await tx
      .update(topicProposals)
      .set({ status: 'accepted', mergedIntoTopicId: created.id })
      .where(eq(topicProposals.id, proposal.id))

    return { ok: true, topicId: created.id, slug, taggedSource }
  })
}

export type MergeOutcome =
  | { ok: true; taggedSource: boolean }
  | { ok: false; reason: 'not_found' | 'not_pending' | 'target_not_found' | 'target_not_leaf' }

export async function mergeTopicProposal(
  db: Db,
  proposalId: string,
  targetTopicId: string,
): Promise<MergeOutcome> {
  const [proposal] = await db
    .select()
    .from(topicProposals)
    .where(eq(topicProposals.id, proposalId))
    .limit(1)

  if (!proposal) return { ok: false, reason: 'not_found' }
  if (proposal.status !== 'pending') return { ok: false, reason: 'not_pending' }

  const [target] = await db.select().from(topics).where(eq(topics.id, targetTopicId)).limit(1)

  if (!target) return { ok: false, reason: 'target_not_found' }
  if (!target.isLeaf) return { ok: false, reason: 'target_not_leaf' }

  let taggedSource = false

  if (proposal.sourceQuestionId) {
    await db
      .insert(questionTopics)
      .values({
        questionId: proposal.sourceQuestionId,
        topicId: target.id,
        confidence: 1,
        assignedBy: 'user',
        isPrimary: true,
      })
      .onConflictDoNothing()

    taggedSource = true
  }

  await db
    .update(topicProposals)
    .set({ status: 'merged', mergedIntoTopicId: target.id })
    .where(eq(topicProposals.id, proposal.id))

  return { ok: true, taggedSource }
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)

  return slug || 'topic'
}

export async function uniqueSlug(db: Db, wanted: string): Promise<string> {
  const candidates = [wanted, ...Array.from({ length: 20 }, (_, i) => `${wanted}-${i + 2}`)]

  const taken = new Set(
    (
      await db
        .select({ slug: topics.slug })
        .from(topics)
        .where(inArray(topics.slug, candidates))
    ).map((row) => row.slug),
  )

  const free = candidates.find((candidate) => !taken.has(candidate))

  return free ?? `${wanted}-${Date.now().toString(36)}`
}
