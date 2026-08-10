import { and, eq, lt } from 'drizzle-orm'

import type { Db } from '@/lib/db/types'
import { worksheetPages, worksheets } from '@/lib/db/schema'
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
 * `uploading` only. `processing` means the pages are up and the job is real
 * work in progress, and a worksheet that failed is left alone deliberately: the
 * student can see it failed, which is the point.
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
        eq(worksheets.status, 'uploading'),
        lt(worksheets.createdAt, cutoff),
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
