import { and, eq, inArray } from 'drizzle-orm'

import { worksheets } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'

export type WorksheetStatus = (typeof worksheets.$inferSelect)['status']

type CompletedStatus = 'queued' | 'awaiting_review'
type Tier = 'trial' | 'free' | 'cloud' | 'ollama'

/**
 * The one place a worksheet's status is allowed to move.
 *
 * Every write to `worksheets.status` outside this file used to be a bare
 * `UPDATE ... WHERE id = ?`, which does whatever the caller says regardless of
 * what the row currently holds. That is how a permanently-failed job could
 * flip a worksheet the student had already reviewed and marked up back to
 * `failed`, or a retried job could re-complete a worksheet a second time: the
 * write itself carried no memory of which transition it was supposed to be.
 *
 * `from` is the guard, in the same style `claimWorksheetForCompletion` and
 * `claimWorksheetForManualFallback` already used: the check and the write are
 * one statement, so two callers racing to make the same transition cannot
 * both succeed, and a caller trying to make a transition that no longer
 * applies (because someone else already moved the row) does nothing rather
 * than clobbering whatever is there now.
 */
export async function transitionWorksheet(
  db: Db,
  worksheetId: string,
  from: readonly WorksheetStatus[],
  set: Partial<typeof worksheets.$inferInsert> & { status: WorksheetStatus },
): Promise<boolean> {
  const claimed = await db
    .update(worksheets)
    .set(set)
    .where(and(eq(worksheets.id, worksheetId), inArray(worksheets.status, [...from])))
    .returning({ id: worksheets.id })

  return claimed.length > 0
}

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
  return transitionWorksheet(db, worksheetId, BEFORE_COMPLETION, { status, tierUsed })
}

/**
 * The other way out of `BEFORE_COMPLETION`: the student gives up on waiting.
 *
 * A worksheet queued while the operator's GPU is offline had no escape at
 * all. It sits in `processing` until the worker comes back, however long
 * that takes, with the only control on the page a link back to the
 * dashboard. This is what lets `POST /api/worksheets/[id]/go-manual` move it
 * to `failed` instead, which reuses the status page's existing manual-entry
 * branch rather than inventing a second one.
 *
 * Same shape as {@link claimWorksheetForCompletion} and for the same reason:
 * the check and the write are one statement, so a double click cannot cancel
 * the same job twice or refund the same trial credit twice.
 */
export async function claimWorksheetForManualFallback(
  db: Db,
  worksheetId: string,
): Promise<boolean> {
  return transitionWorksheet(db, worksheetId, BEFORE_COMPLETION, { status: 'failed' })
}
