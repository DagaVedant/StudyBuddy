import { and, eq, exists, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import type { Db } from '@/lib/db/types'
import { topics } from '@/lib/db/schema'

/**
 * Clears `isLeaf` on every topic that has a child.
 *
 * `isLeaf` is not decoration: shortlisting only considers leaves, so a topic
 * wrongly marked one is offered to the classifier as somewhere a question can
 * land, when its children are the real destinations.
 *
 * The seed is what breaks it. It writes `isLeaf` from the taxonomy definition,
 * where every canonical leaf is a leaf, and an accepted topic proposal hangs a
 * new child off one of them. `acceptTopicProposal` demotes the parent at the
 * time; the next `npm run db:seed` promotes it straight back, because the
 * taxonomy file has never heard of the child. The admin's accepted topic and
 * its own parent then both sit in the shortlist, competing.
 *
 * Written as a repair rather than a special case in the seed's UPDATE so it
 * also fixes a tree that a previous seed already broke.
 *
 * @returns the slugs it had to correct.
 */
export async function demoteParentsWithChildren(db: Db): Promise<string[]> {
  const child = alias(topics, 'child')

  const corrected = await db
    .update(topics)
    .set({ isLeaf: false })
    .where(
      and(
        eq(topics.isLeaf, true),
        exists(
          db
            .select({ one: sql`1` })
            .from(child)
            .where(eq(child.parentId, topics.id)),
        ),
      ),
    )
    .returning({ slug: topics.slug })

  return corrected.map((row) => row.slug)
}
