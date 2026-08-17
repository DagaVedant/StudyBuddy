import { eq } from 'drizzle-orm'

import type { Db } from '@/lib/db/types'
import { users, worksheetPages, worksheets } from '@/lib/db/schema'
import { storage } from '@/lib/storage'

export interface DeletedAccount {
  imagesRemoved: number
  imagesFailed: number
}

export async function deleteAccount(
  db: Db,
  userId: string,
): Promise<DeletedAccount> {
  const keys = await db
    .select({ imageKey: worksheetPages.imageKey })
    .from(worksheetPages)
    .innerJoin(worksheets, eq(worksheets.id, worksheetPages.worksheetId))
    .where(eq(worksheets.userId, userId))

  await db.delete(users).where(eq(users.id, userId))

  const removals = await Promise.allSettled(
    keys.map((page) => storage.remove(page.imageKey)),
  )

  const imagesFailed = removals.filter((result) => result.status === 'rejected').length

  if (imagesFailed > 0) {
    console.error(
      `[account] deleted ${userId} but ${imagesFailed} of ${keys.length} page image(s) ` +
        'could not be removed; they are orphaned in blob storage',
    )
  }

  return { imagesRemoved: keys.length - imagesFailed, imagesFailed }
}
