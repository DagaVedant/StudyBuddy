import { eq } from 'drizzle-orm'

import type { Db } from '@/lib/db/types'
import { users, worksheetPages, worksheets } from '@/lib/db/schema'
import { storage } from '@/lib/storage'

export interface DeletedAccount {
  /** Page images removed from blob storage. */
  imagesRemoved: number
  /** Images the store would not give up. They are orphaned, not retained. */
  imagesFailed: number
}

/**
 * Removes an account and everything belonging to it.
 *
 * Ten of the eleven tables that reference a user cascade on delete, so the row
 * delete takes the sessions, the OAuth accounts, the stored API credentials,
 * the worksheets, their pages and questions and answer choices, every attempt,
 * every review card, every explanation, the processing jobs and the usage
 * events. That is by construction rather than by a list kept here, which is the
 * only version of this that stays correct when a table is added.
 *
 * The eleventh is `topic_proposals.user_id`, which is `set null` on purpose: a
 * proposal is a queue item an admin still has to act on, and it survives the
 * account that raised it with the person detached from it. Deleting the account
 * therefore anonymises the proposal rather than destroying an operator's work.
 *
 * Blob storage is not part of any of that. Page images are collected first,
 * because after the delete there is no row left that names them, and removed
 * afterwards so a store that refuses one file cannot leave the account half
 * deleted. A leftover image is a smaller problem than an account that will not
 * go away; the count of failures is returned so the caller can say so.
 */
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
