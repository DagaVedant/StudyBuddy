import { eq } from 'drizzle-orm'

import { refundTrial } from '@/lib/ai/quota'
import { worksheets } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'

export interface FailedJob {
  stage: string
  userId: string
  worksheetId: string
}

/**
 * What a job failing for the last time costs, and what it does not.
 *
 * Every job carries a `worksheetId`, including the one that writes a single
 * explanation, which takes it from the question it was asked about. Treating
 * them alike did three wrong things at once to a student whose explanation
 * failed three times: refunded a worksheet credit they never spent, left the
 * explanation credit charged, and flipped a finished worksheet to `failed`.
 * That worksheet had been extracted, verified and marked up, with attempts and
 * review cards against it, and the list rendered it as "Failed" while the
 * status page said it had not counted against the trial, which was by then
 * untrue in both directions.
 *
 * So the stage decides. An explanation that could not be written says nothing
 * about the worksheet it came from.
 */
export async function applyPermanentFailure(db: Db, job: FailedJob): Promise<void> {
  if (job.stage === 'explain') {
    await refundTrial(db, job.userId, 'explanations', 1)
    return
  }

  const [worksheet] = await db
    .select({ tierUsed: worksheets.tierUsed })
    .from(worksheets)
    .where(eq(worksheets.id, job.worksheetId))
    .limit(1)

  // Only the trial is refundable. A student's own key already paid whoever
  // owns it, and this app cannot give that back.
  if (worksheet?.tierUsed === 'trial') {
    await refundTrial(db, job.userId, 'worksheets', 1)
  }

  await db
    .update(worksheets)
    .set({ status: 'failed' })
    .where(eq(worksheets.id, job.worksheetId))
}
