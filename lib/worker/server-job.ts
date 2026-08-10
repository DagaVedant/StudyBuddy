import { eq } from 'drizzle-orm'

import { resolveProvider, type ResolvedProvider } from '@/lib/ai/resolve'
import { EmbeddingUnavailableError, classifyWorksheet } from '@/lib/classify'
import type { Db } from '@/lib/db/types'
import { worksheets } from '@/lib/db/schema'
import { claimJob, completeJob, failJob } from '@/lib/queue'
import { runExtraction } from '@/lib/worker/ingest'
import { runRepairPasses } from '@/lib/worker/pipeline'

type Resolver = (db: Db, userId: string) => Promise<ResolvedProvider>

/**
 * Runs Tier B (student's own cloud key) processing in-process on the server.
 *
 * The GPU worker is a separate long-running process that polls
 * `/api/worker/claim`, which only ever asks for `executor: 'operator_gpu'`
 * work: nothing was polling for `executor: 'server'`, so a Tier B upload
 * enqueued a job and then sat there forever. There is no persistent process
 * for Tier B to poll from: the extraction runs against the student's own key,
 * reachable directly from the server, so it does not need an external worker
 * at all; it needs someone to call `claimJob(db, 'server')`.
 *
 * Called from `after()` in the complete route, so it runs once the response
 * has already gone back to the student; extraction can take minutes on a
 * large worksheet, and nothing about the existing flow expects the upload
 * request itself to block on that (Tier 0 doesn't; the browser is sent to a
 * status page that polls).
 *
 * One job per trigger, not ten.
 *
 * This used to drain up to ten, on the reasoning that a burst of uploads would
 * otherwise wait for the next unrelated upload to claim them. That reasoning
 * was right about the queue and wrong about where it runs: `after()` is bounded
 * by the invocation's `maxDuration`, so ten extractions in one callback do not
 * get ten times the budget, they get the same budget and the tenth is killed
 * partway through. A job cut off mid-extraction stays claimed until its TTL
 * expires and then retries from a checkpoint, which is slower than never having
 * batched it.
 *
 * So one job per trigger. A backlog clears one upload at a time, which is
 * slower than the batch was meant to be and is the honest ceiling: a serverless
 * invocation is not a worker process, and pretending otherwise is what produced
 * the half-finished extractions. Anything left waiting is picked up by the next
 * completion, or by the claim TTL expiring and the job going back to pending.
 *
 * `limit` stays a parameter because the tests drive it, and because a real
 * background runner, if one ever exists, can raise it.
 */
export async function drainServerQueue(
  db: Db,
  limit = 1,
  resolve: Resolver = resolveProvider,
): Promise<void> {
  for (let i = 0; i < limit; i += 1) {
    let job
    try {
      // Outside the per-job try/catch below, so its own failure was an
      // unhandled rejection that took the whole drain with it. A connection
      // blip while claiming is not a reason to stop draining.
      job = await claimJob(db, 'server')
    } catch (error) {
      console.error('[server-job] could not claim:', (error as Error).message)
      return
    }

    if (!job) return

    await runOneServerJob(db, job, resolve)
  }
}

async function runOneServerJob(
  db: Db,
  job: {
    id: string
    worksheetId: string
    userId: string
    checkpoint: Record<string, unknown> | null
  },
  resolve: Resolver,
): Promise<void> {
  const { provider, executor } = await resolve(db, job.userId)

  if (executor !== 'server') {
    // The student's key was removed or changed between enqueue and now.
    // Forced permanent: retrying can't fix a missing key, and spreading this
    // over the normal retry schedule would leave the worksheet stuck showing
    // "queued" for two more claims before the student ever sees it failed.
    await failJob(
      db,
      job.id,
      'No cloud API key is configured for this account anymore.',
      true,
    )
    await db
      .update(worksheets)
      .set({ status: 'failed' })
      .where(eq(worksheets.id, job.worksheetId))
    return
  }

  try {
    await runExtraction(db, provider, job)

    // The same passes the GPU path runs, in the same order. Tier B used to
    // list three of them by hand and was missing the split join and the
    // carried-options recovery, so a question the page break cut in two stayed
    // cut in two for anyone processing with their own cloud key. There is only
    // one run here rather than the GPU path's three, because there is neither
    // an audit re-read nor a review re-read in between to produce a second
    // crop of splits, or a question holding half its options.
    await runRepairPasses(db, job.worksheetId)

    const [worksheet] = await db
      .select({ subjectHint: worksheets.subjectHint })
      .from(worksheets)
      .where(eq(worksheets.id, job.worksheetId))
      .limit(1)

    /*
     * Classification is allowed to fail without failing the job, but not
     * allowed to fail quietly.
     *
     * `embed()` loads onnxruntime, which needs a native binary the serverless
     * host may not have. That used to surface as an empty shortlist, which is
     * indistinguishable from a question nothing matched, so the job completed
     * and the student got a worksheet where every question was untagged and a
     * dashboard with nothing on it. Nowhere in the logs was there an error.
     *
     * The worksheet is still worth having: the questions are extracted, the
     * repair passes have run, and markup works without a single topic. So this
     * is reported rather than thrown, and the worksheet still reaches review.
     */
    try {
      const { classified, coarse, failed } = await classifyWorksheet(
        db,
        provider,
        job.worksheetId,
        worksheet?.subjectHint,
      )

      console.log(
        `[server-job] classified ${classified} question(s) on ${job.worksheetId}` +
          `${coarse > 0 ? `, ${coarse} raised a topic proposal` : ''}` +
          `${failed > 0 ? `, ${failed} failed` : ''}`,
      )
    } catch (error) {
      if (error instanceof EmbeddingUnavailableError) {
        // Loud, and once per job rather than once per question. Every worksheet
        // this host processes will be untagged until it is fixed, which is a
        // deployment problem and not a per-question one.
        console.error(
          `[server-job] CLASSIFICATION IS OFF on this host: ${error.message}. ` +
            `Worksheet ${job.worksheetId} is extracted but untagged, and so is ` +
            `every other one until the embedding model can load here.`,
        )
      } else {
        console.error(
          `[server-job] classification failed on ${job.worksheetId}:`,
          (error as Error).message,
        )
      }
    }

    // Last, so the student cannot reach the worksheet while the passes above
    // are still adding, merging and deleting rows. `runExtraction` used to do
    // this the moment the pages were read, which put markup one link away from
    // a job that had not finished repairing itself.
    await db
      .update(worksheets)
      .set({ status: 'awaiting_review' })
      .where(eq(worksheets.id, job.worksheetId))

    await completeJob(db, job.id)
  } catch (error) {
    const { permanent } = await failJob(db, job.id, (error as Error).message)
    // Tier B never draws from the trial, so unlike the operator_gpu path
    // there is no refund to issue here; the student's own key paid for
    // whatever ran before the failure.
    if (permanent) {
      await db
        .update(worksheets)
        .set({ status: 'failed' })
        .where(eq(worksheets.id, job.worksheetId))
    }
  }
}
