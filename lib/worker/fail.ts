import { eq } from 'drizzle-orm'

import { refundTrial } from '@/lib/ai/quota'
import { notifyWorksheet } from '@/lib/notifications/worksheet'
import { worksheets } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'
import type { StoredJobStage } from '@/lib/queue'
import { transitionWorksheet } from '@/lib/upload/claim'

export interface FailedJob {
  stage: StoredJobStage
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

    case 'extract':
    case 'classify': {
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
