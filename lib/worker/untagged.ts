import { eq } from 'drizzle-orm'

import { worksheets } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'

export const UNTAGGED_REASON = {
  classifierDown:
    'The topic classifier was unavailable while this worksheet was processed, so no topics were assigned.',
  classifierFailed:
    'Topic classification failed while this worksheet was processed, so no topics were assigned.',
  tierCUnsupported:
    'Ollama read this worksheet in your browser, which does not sort questions into topics yet, so none were assigned.',
} as const

export type UntaggedReason = (typeof UNTAGGED_REASON)[keyof typeof UNTAGGED_REASON]

export async function recordUntagged(
  db: Db,
  worksheetId: string,
  reason: UntaggedReason,
): Promise<void> {
  await db
    .update(worksheets)
    .set({ classificationError: reason })
    .where(eq(worksheets.id, worksheetId))
}
