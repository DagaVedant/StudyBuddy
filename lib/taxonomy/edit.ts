import { eq } from 'drizzle-orm'

import { isUniqueViolation } from '@/lib/db/errors'
import type { Db } from '@/lib/db/types'
import { topics } from '@/lib/db/schema'
import { slugify, uniqueSlug } from '@/lib/classify/proposals'
import { embed } from '@/lib/embeddings'

/** How many times to lose a race for a slug before giving up on it. */
const SLUG_ATTEMPTS = 3

export type CreateTopicOutcome =
  | { ok: true; topicId: string; slug: string }
  | { ok: false; reason: 'parent_not_found' }

/**
 * spec.md §2.1's "Add" - a topic an admin places directly, for the cases a
 * proposal never covers: seeding a subject nobody has asked a question about
 * yet, or splitting a leaf that turned out to need two.
 *
 * Embedded the same way `proposeTopic` embeds a proposal - straight off the
 * name, nothing fancier - because that is what makes a topic shortlistable at
 * all. A topic added without one would sit in the tree and never be offered
 * to the classifier, which is a topic in name only.
 */
export async function createTopic(
  db: Db,
  parentId: string,
  name: string,
): Promise<CreateTopicOutcome> {
  const trimmed = name.trim().slice(0, 120)
  const [parent] = await db.select().from(topics).where(eq(topics.id, parentId)).limit(1)

  if (!parent) return { ok: false, reason: 'parent_not_found' }

  const wanted = `${parent.slug}.${slugify(trimmed)}`
  const vector = await embed(trimmed)

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        const slug = await uniqueSlug(tx, wanted)

        const [created] = await tx
          .insert(topics)
          .values({
            parentId: parent.id,
            slug,
            name: trimmed,
            depth: parent.depth + 1,
            subjectRoot: parent.subjectRoot,
            isCanonical: false,
            isLeaf: true,
            embedding: vector,
          })
          .returning({ id: topics.id })

        // The parent has a child now, so it is no longer somewhere a question
        // can land directly. Same rule accepting a proposal already follows.
        if (parent.isLeaf) {
          await tx.update(topics).set({ isLeaf: false }).where(eq(topics.id, parent.id))
        }

        return { ok: true, topicId: created.id, slug }
      })
    } catch (error) {
      if (!isUniqueViolation(error) || attempt >= SLUG_ATTEMPTS) throw error
    }
  }
}

export type RenameTopicOutcome = { ok: true } | { ok: false; reason: 'not_found' }

/**
 * Changes only what is shown, never `slug`.
 *
 * `slug` doubles as the tree's path (lib/classify/index.ts:86 narrows a
 * shortlist with a `LIKE slug.%` on it, and `nearestAncestor` walks it by
 * trimming segments), so keeping it stable after a rename is not a
 * shortcut - it is what makes the rename safe to do without touching every
 * descendant's slug too. A topic's display name and its path are allowed to
 * disagree; nothing downstream of `slug` reads `name`.
 */
export async function renameTopic(
  db: Db,
  topicId: string,
  name: string,
): Promise<RenameTopicOutcome> {
  const trimmed = name.trim().slice(0, 120)
  if (!trimmed) return { ok: false, reason: 'not_found' }

  const renamed = await db
    .update(topics)
    .set({ name: trimmed })
    .where(eq(topics.id, topicId))
    .returning({ id: topics.id })

  return renamed.length > 0 ? { ok: true } : { ok: false, reason: 'not_found' }
}

export type ReparentTopicOutcome =
  | { ok: true; slug: string }
  | {
      ok: false
      reason: 'not_found' | 'not_leaf' | 'target_not_found' | 'target_is_self' | 'same_parent'
    }

/**
 * spec.md §2.1's "reparent", restricted to leaves.
 *
 * An internal node's slug is a prefix every descendant's slug is built from,
 * so moving one would mean rewriting every descendant's slug to match - a
 * real migration, not a metadata edit, and one wrong write away from
 * breaking the `LIKE`-based subject narrowing every classification call
 * makes. A leaf has no descendants, so moving it is one row: a fresh slug
 * under the new parent, nothing beneath it to follow.
 *
 * Every topic an admin can create (`createTopic`) or a proposal can add
 * (`acceptTopicProposal`) is created as a leaf, and only a leaf is ever
 * misfiled in the first place - an internal node's position was a
 * deliberate choice when the seed built it, not something to second-guess
 * here.
 */
export async function reparentTopic(
  db: Db,
  topicId: string,
  newParentId: string,
): Promise<ReparentTopicOutcome> {
  if (topicId === newParentId) return { ok: false, reason: 'target_is_self' }

  return db.transaction(async (tx) => {
    const [topic] = await tx.select().from(topics).where(eq(topics.id, topicId)).limit(1)
    if (!topic) return { ok: false, reason: 'not_found' }
    if (!topic.isLeaf) return { ok: false, reason: 'not_leaf' }
    if (topic.parentId === newParentId) return { ok: false, reason: 'same_parent' }

    const [newParent] = await tx
      .select()
      .from(topics)
      .where(eq(topics.id, newParentId))
      .limit(1)
    if (!newParent) return { ok: false, reason: 'target_not_found' }

    const lastSegment = topic.slug.split('.').pop() ?? topic.slug
    const wanted = `${newParent.slug}.${lastSegment}`
    const slug = await uniqueSlug(tx, wanted)
    const oldParentId = topic.parentId

    await tx
      .update(topics)
      .set({
        parentId: newParent.id,
        slug,
        depth: newParent.depth + 1,
        subjectRoot: newParent.subjectRoot,
      })
      .where(eq(topics.id, topic.id))

    if (newParent.isLeaf) {
      await tx.update(topics).set({ isLeaf: false }).where(eq(topics.id, newParent.id))
    }

    // The mirror image of gaining a child: the old parent may have just lost
    // its last one, and a parent with no children left is a leaf again.
    if (oldParentId) {
      const remainingSiblings = await tx
        .select({ id: topics.id })
        .from(topics)
        .where(eq(topics.parentId, oldParentId))
        .limit(1)

      if (remainingSiblings.length === 0) {
        await tx.update(topics).set({ isLeaf: true }).where(eq(topics.id, oldParentId))
      }
    }

    return { ok: true, slug }
  })
}
