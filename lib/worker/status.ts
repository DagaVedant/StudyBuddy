import { eq } from 'drizzle-orm'

import { notifyWorksheet } from '@/lib/notifications'
import { refundTrial } from '@/lib/ai/quota'
import { transitionWorksheet } from '@/lib/upload/claim'
import { type Db } from '@/lib/db/types'
import { type JobStage } from '@/lib/queue'
import { worksheets } from '@/lib/db/schema'

export const READING_SHARE = 0.8
export const VERIFYING_AT = 0.8
export const CLASSIFYING_AT = 0.95

export type JobPhase = 'reading' | 'verifying' | 'classifying'

export function readingProgress(pageNumber: number, totalPages: number): number {
  if (totalPages <= 0) return 0
  return (pageNumber / totalPages) * READING_SHARE
}

export function phaseFor(progress: number): JobPhase {
  if (progress >= CLASSIFYING_AT) return 'classifying'
  if (progress >= VERIFYING_AT) return 'verifying'
  return 'reading'
}

export interface FailedJob {
  stage: JobStage
  userId: string
  worksheetId: string
}

export async function applyPermanentFailure(db: Db, job: FailedJob): Promise<void> {
  switch (job.stage) {
    case 'explain':
      await refundTrial(db, job.userId, 'explanations', 1)
      return

    case 'answer_key':
      return

    case 'classify':
      await recordUntagged(db, job.worksheetId, UNTAGGED_REASON.browserPending)
      return

    case 'extract': {
      const [worksheet] = await db
        .select({ tierUsed: worksheets.tierUsed })
        .from(worksheets)
        .where(eq(worksheets.id, job.worksheetId))
        .limit(1)

      if (worksheet?.tierUsed === 'trial') {
        await refundTrial(db, job.userId, 'worksheets', 1)
      }

      const failed = await transitionWorksheet(
        db,
        job.worksheetId,
        ['queued', 'processing'],
        { status: 'failed' },
      )

      if (failed) {
        await notifyWorksheet(db, job.userId, job.worksheetId, 'worksheet_failed')
      }

      return
    }
  }
}

export const UNTAGGED_REASON = {
  classifierDown:
    'The topic classifier was unavailable while this worksheet was processed, so no topics were assigned.',
  classifierFailed:
    'Topic classification failed while this worksheet was processed, so no topics were assigned.',
  browserPending:
    'These questions are not sorted into topics yet. The model that sorts them cannot run on our server, so it runs in your browser instead, on this screen.',
  workerQueued:
    'These questions are not sorted into topics yet. The model that sorts them cannot run on our server, so they are queued for the machine that runs it. Sorting them here instead keeps them on your own machine, and is quicker.',
} as const

export type UntaggedReason = (typeof UNTAGGED_REASON)[keyof typeof UNTAGGED_REASON]

export async function recordUntagged(
  db: Db,
  worksheetId: string,
  reason: UntaggedReason,
): Promise<void> {
  await db
    .update(worksheets)
    .set({ classificationError: reason })
    .where(eq(worksheets.id, worksheetId))
}

export async function clearUntagged(db: Db, worksheetId: string): Promise<void> {
  await db
    .update(worksheets)
    .set({ classificationError: null })
    .where(eq(worksheets.id, worksheetId))
}
