import { and, eq, lt, notExists, or, sql } from 'drizzle-orm'

import type { Db } from '@/lib/db/types'
import { processingJobs, worksheetPages, worksheets } from '@/lib/db/schema'
import { storage } from '@/lib/storage'

export const ABANDONED_AFTER_MS = 60 * 60_000

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
    const pages = await db
      .select({ imageKey: worksheetPages.imageKey })
      .from(worksheetPages)
      .where(eq(worksheetPages.worksheetId, sheet.id))

    await db.delete(worksheets).where(eq(worksheets.id, sheet.id))

    await Promise.allSettled(pages.map((page) => storage.remove(page.imageKey)))
  }

  return stale.length
}
