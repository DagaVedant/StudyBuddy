import { eq } from 'drizzle-orm'

import { worksheets } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'

import { notify, type NotificationKind } from './index'

/**
 * The one notification this app sends, in its two outcomes.
 *
 * Written here rather than at each call site so the copy is decided once: a job
 * finishing is reported from the worker route, the Tier B drain and the failure
 * path, and three near-identical sentences drift the moment one of them is
 * edited.
 *
 * The title is the worksheet's own, because that is what a student recognises
 * on a lock screen. Everything else is the same two sentences every time.
 */
export async function notifyWorksheet(
  db: Db,
  userId: string,
  worksheetId: string,
  kind: NotificationKind,
): Promise<void> {
  const [worksheet] = await db
    .select({ title: worksheets.title })
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  // Gone between the job finishing and this running, which a deleted worksheet
  // does. Nothing to announce and nowhere to send them.
  if (!worksheet) return

  const ready = kind === 'worksheet_ready'

  await notify(db, {
    userId,
    kind,
    title: worksheet.title,
    body: ready
      ? 'Your worksheet is read and ready to check.'
      : 'We could not read this worksheet. It was not counted against your trial.',
    // Deliberately not `destination()`. That function answers "where should a
    // card take you", which depends on state this notification will outlive:
    // by the time it is opened the worksheet may have been checked, marked, or
    // both. The status page is the one screen that always resolves to the right
    // next step, because it asks `destination()` itself at the moment of the
    // click rather than at the moment of the write.
    href: `/worksheets/${worksheetId}/status`,
  })
}
