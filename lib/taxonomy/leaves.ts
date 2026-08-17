import { and, eq, exists, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import type { Db } from '@/lib/db/types'
import { topics } from '@/lib/db/schema'

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
