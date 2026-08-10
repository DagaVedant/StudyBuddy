import { and, eq, inArray } from 'drizzle-orm'

import { worksheets } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'

type CompletedStatus = 'queued' | 'awaiting_review'
type Tier = 'trial' | 'free' | 'cloud' | 'ollama'

/**
 * The states a worksheet is in before anyone has finished it.
 *
 * `uploading` is what it is created as, and `processing` is what the page
 * upload route moves it to as soon as the first page lands, so by the time
 * `/complete` is called it is always the second one. Both count as "not
 * finished"; everything after them means some call already did this work.
 */
const BEFORE_COMPLETION = ['uploading', 'processing'] as const

/**
 * Finishes a worksheet, and reports whether this caller is the one that did it.
 *
 * `POST /complete` either spends a trial worksheet or queues a job, and often
 * both, so it must happen once per worksheet rather than once per call. It had
 * no guard at all: a double-click on the finish button, or the client retrying
 * on a flaky connection, charged the student again and queued the same
 * worksheet again.
 *
 * The check and the write are one statement rather than a read followed by a
 * write, because two requests arriving together would both pass a read.
 * Postgres lets exactly one of them match; the other updates no rows and is
 * told so.
 */
export async function claimWorksheetForCompletion(
  db: Db,
  worksheetId: string,
  status: CompletedStatus,
  tierUsed: Tier,
): Promise<boolean> {
  const claimed = await db
    .update(worksheets)
    .set({ status, tierUsed })
    .where(
      and(
        eq(worksheets.id, worksheetId),
        inArray(worksheets.status, [...BEFORE_COMPLETION]),
      ),
    )
    .returning({ id: worksheets.id })

  return claimed.length > 0
}
