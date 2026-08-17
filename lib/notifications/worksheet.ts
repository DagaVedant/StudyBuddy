import { eq } from 'drizzle-orm'

import { worksheets } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'

import { notify, type NotificationKind } from './index'

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

  if (!worksheet) return

  const ready = kind === 'worksheet_ready'

  await notify(db, {
    userId,
    kind,
    title: worksheet.title,
    body: ready
      ? 'Your worksheet is read and ready to check.'
      : 'We could not read this worksheet. It was not counted against your trial.',
    href: `/worksheets/${worksheetId}/status`,
  })
}
