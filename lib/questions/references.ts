import { and, eq } from 'drizzle-orm'

import type { Db } from '@/lib/db/types'
import { topics, worksheetPages } from '@/lib/db/schema'

export interface ReferenceCheck {
  ok: boolean
  field?: 'pageId' | 'topicId'
}

export async function checkReferences(
  db: Db,
  worksheetId: string,
  input: { pageId?: string | null; topicId?: string | null },
): Promise<ReferenceCheck> {
  if (input.pageId) {
    const [page] = await db
      .select({ id: worksheetPages.id })
      .from(worksheetPages)
      .where(
        and(
          eq(worksheetPages.id, input.pageId),
          eq(worksheetPages.worksheetId, worksheetId),
        ),
      )
      .limit(1)

    if (!page) return { ok: false, field: 'pageId' }
  }

  if (input.topicId) {
    const [topic] = await db
      .select({ id: topics.id })
      .from(topics)
      .where(eq(topics.id, input.topicId))
      .limit(1)

    if (!topic) return { ok: false, field: 'topicId' }
  }

  return { ok: true }
}

export function referenceError(field: 'pageId' | 'topicId'): string {
  return field === 'pageId'
    ? 'That page is not part of this worksheet.'
    : 'That topic no longer exists. Pick another one.'
}
