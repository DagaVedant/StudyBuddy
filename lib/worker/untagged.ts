import { eq } from 'drizzle-orm'

import { worksheets } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'

/**
 * Why a worksheet arrived with no topics on it, in the student's words.
 *
 * Finding 8/106 asked for the job to "fail loudly rather than completing it
 * untagged". That was the right complaint and the wrong remedy, and the remedy
 * is worth arguing with rather than quietly not doing.
 *
 * Failing the job means the worksheet reaches `failed`: the extracted questions
 * are unreachable, the trial credit comes back, and a student who wanted a
 * worksheet has a refund instead. But the paper is genuinely fine. The questions
 * were read, the repair passes ran, and marking, review and the Blooket export
 * all work without a single topic attached. The only thing missing is the
 * weakness ranking, which is a feature of the dashboard rather than of the
 * worksheet. Throwing the paper away to signal a missing feature is a worse
 * trade than keeping it.
 *
 * What the finding was actually right about is that it was *silent*: the job
 * reported success, and only a server log said otherwise. So the job still
 * completes, and the reason is written where the student will meet the
 * consequence.
 */
export const UNTAGGED_REASON = {
  /** The embedding model would not load on the host that did the extraction. */
  classifierDown:
    'The topic classifier was unavailable while this worksheet was processed, so no topics were assigned.',
  /** Anything else thrown out of `classifyWorksheet`. */
  classifierFailed:
    'Topic classification failed while this worksheet was processed, so no topics were assigned.',
  /**
   * Tier C, which reads pages in the student's own browser and stops there.
   *
   * Not a failure at all: nothing went wrong, the tier does not do this part
   * yet. Saying so is the difference between a known limit and a worksheet that
   * looks broken for reasons nobody explains.
   */
  tierCUnsupported:
    'Ollama read this worksheet in your browser, which does not sort questions into topics yet, so none were assigned.',
} as const

export type UntaggedReason = (typeof UNTAGGED_REASON)[keyof typeof UNTAGGED_REASON]

/**
 * Record that a worksheet finished with no topics, and why.
 *
 * One writer for all of it, because the same thing happens on three tiers and
 * the wording drifts the moment each writes its own. The column is what the
 * check screen reads, and now what the dashboard reads to explain an empty
 * weakness panel.
 */
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
