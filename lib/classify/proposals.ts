import { eq, inArray } from 'drizzle-orm'

import type { Db } from '@/lib/db/types'
import { questionTopics, topicProposals, topics } from '@/lib/db/schema'
import { isUniqueViolation } from '@/lib/db/errors'

export type AcceptOutcome =
  | { ok: true; topicId: string; slug: string; taggedSource: boolean }
  | { ok: false; reason: 'not_found' | 'not_pending' | 'no_parent' }

/**
 * Turns a proposal into a real topic.
 *
 * Accepting used to only flip the proposal's status, which nothing read; the
 * queue looked like it worked and the tree never changed, so the same
 * proposal would be raised again by the next question that did not fit.
 *
 * The new topic is marked non-canonical: it did not come from the seeded
 * taxonomy, and keeping that distinction means a later re-seed can tell what
 * it is allowed to overwrite. That is all the flag means; it does not gate
 * shortlisting, which it used to, with the result that an accepted topic could
 * never be matched to anything.
 *
 * The writes run in one transaction. There are four of them and they are only
 * coherent together: a topic whose parent is still a leaf, or a proposal
 * pointing at a topic that was never created, is worse than a proposal nobody
 * has got to yet.
 *
 * Picking the slug is inside that transaction and the whole thing retries on a
 * collision, because `topics.slug` is unique and choosing a free one is a read
 * followed by a write. Two admins accepting from the queue at the same time,
 * or the same admin double-clicking Accept, could both read the same slug as
 * free; whoever inserted second used to get a constraint violation thrown out
 * of here as a 500, with the proposal left pending and no indication that the
 * name was the problem. Two proposals with names that slugify the same is not
 * a rare shape either: "Circle theorems" and "circle theorems!" are one slug.
 */
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

  // Without a parent there is nowhere in the tree to hang it, and a topic
  // outside the tree would never be shortlisted, so it would be worse than
  // leaving the proposal pending for someone to place by hand.
  if (!proposal.suggestedParentId) return { ok: false, reason: 'no_parent' }

  const [parent] = await db
    .select()
    .from(topics)
    .where(eq(topics.id, proposal.suggestedParentId))
    .limit(1)

  if (!parent) return { ok: false, reason: 'no_parent' }

  const wanted = `${parent.slug}.${slugify(proposal.proposedName)}`

  // A violation aborts the transaction it happened in, so the retry has to be
  // around the whole thing rather than around the insert.
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await accept(db, proposal, parent, wanted)
    } catch (error) {
      if (!isUniqueViolation(error) || attempt >= SLUG_ATTEMPTS) throw error

      // Someone took the slug between the read and the write. Re-reading is the
      // whole fix: `uniqueSlug` will now see it taken and step past it.
      console.warn(
        `[proposals] slug collision on ${wanted}, attempt ${attempt}; retrying`,
      )
    }
  }
}

/** How many times to lose a race for a slug before giving up on it. */
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
        // Carried over so the new topic is shortlistable straight away. Without
        // it the topic exists but no question would ever be matched to it.
        embedding: proposal.embedding,
      })
      .returning({ id: topics.id })

    // The parent has a child now, so it is no longer somewhere a question can
    // land directly.
    if (parent.isLeaf) {
      await tx.update(topics).set({ isLeaf: false }).where(eq(topics.id, parent.id))
    }

    let taggedSource = false

    if (proposal.sourceQuestionId) {
      // The question that could not be classified is the one question we know
      // belongs here, so it gets the tag without waiting to be reclassified.
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

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)

  // Slugs are joined with dots into a path, so an empty segment would produce
  // a path that reads as though a level were missing.
  return slug || 'topic'
}

/** Appends a counter until the slug is free, since slugs are unique. */
async function uniqueSlug(db: Db, wanted: string): Promise<string> {
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

  // Twenty collisions on one name means something is wrong upstream; a random
  // suffix keeps the insert from failing outright.
  return free ?? `${wanted}-${Date.now().toString(36)}`
}
