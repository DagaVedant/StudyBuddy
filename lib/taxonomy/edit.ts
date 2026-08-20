import { eq } from 'drizzle-orm'

import { type Db, isUniqueViolation } from '@/lib/db/types'
import { topics } from '@/lib/db/schema'
import { slugify, uniqueSlug } from '@/lib/classify/proposals'
import { embed } from '@/lib/embeddings'

const SLUG_ATTEMPTS = 3

export type CreateTopicOutcome =
  | { ok: true; topicId: string; slug: string }
  | { ok: false; reason: 'parent_not_found' }

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
