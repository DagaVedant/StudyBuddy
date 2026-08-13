import { eq } from 'drizzle-orm'

import { refundTrial } from '@/lib/ai/quota'
import { worksheets } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'
import type { StoredJobStage } from '@/lib/queue'
import { transitionWorksheet } from '@/lib/upload/claim'

export interface FailedJob {
  /**
   * Typed rather than `string`, which is the whole point of this file.
   *
   * The stage decides what a failure costs, and a `string` let a new stage be
   * added without anyone deciding. `answer_key` was added and inherited the
   * behaviour written for extraction, because that was what the fall-through
   * did. Narrowing it means the switch below stops compiling until the next
   * stage says which of these it is.
   */
  stage: StoredJobStage
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
 *
 * The trap this walked into a second time is the shape of the decision rather
 * than any one branch. It read "if explain, refund an explanation; otherwise
 * refund a worksheet and fail it", so every stage added later inherited the
 * destructive branch by default. `answer_key` did: solving runs after the
 * worksheet is finished and readable, takes the better part of an hour on a
 * long paper, and never checkpoints, so it is the stage most likely to be
 * reaped at the ceiling. Reaching this function it refunded a worksheet credit
 * that was correctly spent on an extraction that succeeded, and marked a paper
 * the student may already have marked up as failed.
 *
 * It is a switch now, and the default is gone. A stage that only adds to a
 * finished worksheet must not be able to take it away by being forgotten.
 */
export async function applyPermanentFailure(db: Db, job: FailedJob): Promise<void> {
  switch (job.stage) {
    case 'explain':
      // Charged per explanation, so that is what comes back. The worksheet is
      // untouched: it was finished long before anyone asked about a question.
      await refundTrial(db, job.userId, 'explanations', 1)
      return

    case 'answer_key':
      /*
       * Nothing to refund and nothing to fail.
       *
       * The worksheet credit bought the extraction, which succeeded, so there
       * is no charge to give back. And by the time solving runs the paper is
       * extracted, repaired, classified and in the student's hands; failing it
       * here would delete finished work over answers that are an addition to
       * it. A paper with no worked answers is the paper they already had.
       */
      return

    case 'extract':
    case 'classify': {
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

      // Guarded to the states a job can still be running from. A worksheet
      // that already reached `awaiting_review` or `ready` while this failure
      // was being applied finished by some other route, and a stale failure
      // arriving after it must not drag a delivered worksheet back to failed.
      await transitionWorksheet(db, job.worksheetId, ['queued', 'processing'], {
        status: 'failed',
      })

      return
    }
  }
}
