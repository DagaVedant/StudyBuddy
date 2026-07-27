import { eq } from 'drizzle-orm'

import { resolveProvider, type ResolvedProvider } from '@/lib/ai/resolve'
import { classifyWorksheet } from '@/lib/classify'
import type { Db } from '@/lib/dashboard/queries'
import { worksheets } from '@/lib/db/schema'
import { claimJob, completeJob, failJob } from '@/lib/queue'
import { runExtraction } from '@/lib/worker/ingest'

type Resolver = (db: Db, userId: string) => Promise<ResolvedProvider>

/**
 * Runs Tier B (student's own cloud key) processing in-process on the server.
 *
 * The GPU worker is a separate long-running process that polls
 * `/api/worker/claim`, which only ever asks for `executor: 'operator_gpu'`
 * work — nothing was polling for `executor: 'server'`, so a Tier B upload
 * enqueued a job and then sat there forever. There is no persistent process
 * for Tier B to poll from: the extraction runs against the student's own key,
 * reachable directly from the server, so it does not need an external worker
 * at all — it needs someone to call `claimJob(db, 'server')`.
 *
 * Called from `after()` in the complete route, so it runs once the response
 * has already gone back to the student — extraction can take minutes on a
 * large worksheet, and nothing about the existing flow expects the upload
 * request itself to block on that (Tier 0 doesn't; the browser is sent to a
 * status page that polls).
 *
 * Drains the whole `server` queue rather than claiming one job, up to `limit`
 * — a single trigger is the only thing that runs this, so if enqueue ever
 * outpaces one-job-per-trigger processing (e.g. a burst of uploads, or a
 * backlog from retried failures), jobs would otherwise wait for the next
 * unrelated upload to happen to trigger a claim.
 */
export async function drainServerQueue(
  db: Db,
  limit = 10,
  resolve: Resolver = resolveProvider,
): Promise<void> {
  for (let i = 0; i < limit; i += 1) {
    const job = await claimJob(db, 'server')
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

    const [worksheet] = await db
      .select({ subjectHint: worksheets.subjectHint })
      .from(worksheets)
      .where(eq(worksheets.id, job.worksheetId))
      .limit(1)

    await classifyWorksheet(db, provider, job.worksheetId, worksheet?.subjectHint)
    await completeJob(db, job.id)
  } catch (error) {
    const { permanent } = await failJob(db, job.id, (error as Error).message)
    // Tier B never draws from the trial, so unlike the operator_gpu path
    // there is no refund to issue here — the student's own key paid for
    // whatever ran before the failure.
    if (permanent) {
      await db
        .update(worksheets)
        .set({ status: 'failed' })
        .where(eq(worksheets.id, job.worksheetId))
    }
  }
}
