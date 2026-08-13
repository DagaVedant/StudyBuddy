import { and, eq, lt, notExists, or, sql } from 'drizzle-orm'

import type { Db } from '@/lib/db/types'
import { processingJobs, worksheetPages, worksheets } from '@/lib/db/schema'
import { storage } from '@/lib/storage'

/**
 * How long an upload may sit half-finished before it counts as abandoned.
 *
 * Generously past the slowest real upload. Rasterizing and recognizing a
 * seventy-five page scan on a phone is minutes, not an hour, and a worksheet
 * that has not reached `processing` in an hour is not coming back: the tab is
 * closed or the browser was killed mid-run.
 */
export const ABANDONED_AFTER_MS = 60 * 60_000

/**
 * Deletes one student's half-finished uploads and the images under them.
 *
 * Cancel deletes what it started, which covers the case where somebody presses
 * the button. It cannot cover the tab that was closed, the laptop that slept,
 * or the browser that was killed partway through, and each of those leaves a
 * worksheet row in `uploading` with page images already in blob storage that
 * nothing will ever read.
 *
 * Scoped to one account on purpose. There is no scheduler in this app, so this
 * runs opportunistically when that same student starts their next upload, which
 * is both the moment it is cheapest and the moment their own leftovers are
 * worth clearing. A global sweep would be a cron job that does not exist.
 *
 * A worksheet that failed is left alone deliberately: the student can see it
 * failed, which is the point.
 *
 * This used to look at `uploading` only, on the reasoning that `processing`
 * means real work in progress. The first page POST moves a worksheet to
 * `processing` (app/api/worksheets/[id]/pages/route.ts), so `uploading` is the
 * state before any page has landed, which is the one variant of an abandoned
 * upload that holds no images at all. Every case this was written for, closing
 * the tab at page 40 of 75, was in `processing` and invisible to it: 40 page
 * rows and 40 blobs stayed, and the dashboard entry stayed too, reading
 * "Processing" for ever.
 *
 * So `processing` counts as well, but only with nothing in the queue for it.
 * Every path out of the completion route either enqueues a job or sets the
 * worksheet to `awaiting_review` first, so a worksheet sitting in `processing`
 * an hour later with no job was never completed and no longer can be. A real
 * extraction has a row in `processing_jobs` from the moment it is handed off,
 * including a failed one, so nothing in flight is in reach of this.
 */
export async function sweepAbandonedUploads(
  db: Db,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - ABANDONED_AFTER_MS)

  const stale = await db
    .select({ id: worksheets.id })
    .from(worksheets)
    .where(
      and(
        eq(worksheets.userId, userId),
        lt(worksheets.createdAt, cutoff),
        or(
          eq(worksheets.status, 'uploading'),
          and(
            eq(worksheets.status, 'processing'),
            notExists(
              db
                .select({ one: sql`1` })
                .from(processingJobs)
                .where(eq(processingJobs.worksheetId, worksheets.id)),
            ),
          ),
        ),
      ),
    )

  if (stale.length === 0) return 0

  for (const sheet of stale) {
    // Read before the delete, because the rows go with the worksheet.
    const pages = await db
      .select({ imageKey: worksheetPages.imageKey })
      .from(worksheetPages)
      .where(eq(worksheetPages.worksheetId, sheet.id))

    await db.delete(worksheets).where(eq(worksheets.id, sheet.id))

    // Best effort, and after the row is gone. An orphaned blob costs storage;
    // a worksheet that will not delete because a file was already missing
    // costs the student their next upload.
    await Promise.allSettled(pages.map((page) => storage.remove(page.imageKey)))
  }

  return stale.length
}
