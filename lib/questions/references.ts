import { and, eq } from 'drizzle-orm'

import type { Db } from '@/lib/db/types'
import { topics, worksheetPages } from '@/lib/db/schema'

/**
 * Checks the two ids a client is allowed to name before they reach an INSERT.
 *
 * `pageId` and `topicId` arrive from the review screen and went straight into
 * the row. Neither is checked by the schema in a way the caller survives: both
 * are foreign keys, so a wrong one is a Postgres constraint violation thrown
 * out of the transaction and rendered as a 500. A student who picked a topic
 * that had just been merged away got "something went wrong" and lost the edit.
 *
 * `pageId` gets the stronger check of the two, because it is the one that can
 * point somewhere it should not: a page id belonging to a different worksheet
 * would attach a question to a stranger's scan. So it is verified against this
 * worksheet, not merely verified to exist.
 *
 * Topics are shared across every account by design, so existence is the whole
 * check there.
 */
export interface ReferenceCheck {
  ok: boolean
  /** Which field was wrong, for the message the caller returns. */
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

/** What to tell the client, which is different from what went wrong. */
export function referenceError(field: 'pageId' | 'topicId'): string {
  return field === 'pageId'
    ? 'That page is not part of this worksheet.'
    : 'That topic no longer exists. Pick another one.'
}
