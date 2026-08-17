import { eq } from 'drizzle-orm'

import { worksheets } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'

export const UNTAGGED_REASON = {
  classifierDown:
    'The topic classifier was unavailable while this worksheet was processed, so no topics were assigned.',
  classifierFailed:
    'Topic classification failed while this worksheet was processed, so no topics were assigned.',
  browserPending:
    'These questions are not sorted into topics yet. The model that sorts them cannot run on our server, so it runs in your browser instead, on this screen.',
  workerQueued:
    'These questions are not sorted into topics yet. The model that sorts them cannot run on our server, so they are queued for the machine that runs it. Sorting them here instead keeps them on your own machine, and is quicker.',
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

export async function clearUntagged(db: Db, worksheetId: string): Promise<void> {
  await db
    .update(worksheets)
    .set({ classificationError: null })
    .where(eq(worksheets.id, worksheetId))
}
