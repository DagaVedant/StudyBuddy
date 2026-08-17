import { and, eq, inArray } from 'drizzle-orm'

import { worksheets } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'

export type WorksheetStatus = (typeof worksheets.$inferSelect)['status']

type CompletedStatus = 'queued' | 'awaiting_review'
type Tier = 'trial' | 'free' | 'cloud' | 'ollama'

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

const BEFORE_COMPLETION = ['uploading', 'processing'] as const

export async function claimWorksheetForCompletion(
  db: Db,
  worksheetId: string,
  status: CompletedStatus,
  tierUsed: Tier,
): Promise<boolean> {
  return transitionWorksheet(db, worksheetId, BEFORE_COMPLETION, { status, tierUsed })
}

export async function claimWorksheetForManualFallback(
  db: Db,
  worksheetId: string,
): Promise<boolean> {
  return transitionWorksheet(db, worksheetId, BEFORE_COMPLETION, { status: 'failed' })
}
