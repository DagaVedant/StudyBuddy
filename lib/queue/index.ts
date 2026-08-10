import { and, count, eq, gte, inArray, lt, sql } from 'drizzle-orm'

import { unwrapDriverRows } from '@/lib/db/rows'
import { gpuWorkers, processingJobs } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'

export type JobExecutor = 'server' | 'browser' | 'operator_gpu'

/**
 * The stages a job can be enqueued as.
 *
 * Deliberately narrower than the `job_stage` column, which also carries
 * `answer_key` and `classify`. Neither has ever run. The answer key is applied
 * as a repair pass at the end of the extract job, because it matches on the
 * printed number and cannot run until the numbering has settled, and
 * classification runs from its own route once the questions exist. Both are in
 * the right place; what was wrong was the type saying they were stages, which
 * is how `answer_key` sat there declared and unimplemented long enough for 288
 * questions to be stored with no answer on any of them.
 *
 * The column keeps its four labels: removing one from a Postgres enum means
 * rebuilding the type and every column that uses it, which is a real migration
 * against live data to buy back two labels nothing can now write. Narrowing
 * here costs nothing and makes the compiler say so.
 */
export type JobStage = 'extract' | 'explain'

/** Every label the column can hold, including the two nothing enqueues. */
export type StoredJobStage = JobStage | 'answer_key' | 'classify'

export type JobPriority = 'high' | 'normal' | 'low'

export const MAX_ATTEMPTS = 3

export const CLAIM_TTL_MS = 15 * 60_000

export const HEARTBEAT_TTL_MS = 90_000

export interface EnqueueArgs {
  worksheetId: string
  userId: string
  stage: JobStage
  executor: JobExecutor
  priority?: JobPriority
  /**
   * Work the stage needs that the worksheet id does not carry.
   *
   * Extraction needs nothing here, since the worksheet is the whole job. An
   * explanation is about one question, and this is where it says which.
   */
  checkpoint?: Record<string, unknown>
}

/**
 * Extraction jobs one student may have waiting on the GPU at once (spec.md:583).
 *
 * One, because that is also how many the GPU can do at once: the worker claims
 * a single job and works it to the end. A student with five queued is not
 * getting five worksheets faster, they are holding the queue against everybody
 * else, and the enqueue endpoint had nothing at all stopping them from doing it
 * on purpose.
 *
 * Counted for extract only. Explanations go through the same executor but are
 * already bounded twice over: `pendingExplainJob` folds a second click on the
 * same question into the first, and EXPLAIN_LIMIT caps the rate. Folding them
 * into this number would mean a student who uploaded a worksheet could not ask
 * about a question from last week until it finished, which is a worse product
 * for no extra safety.
 */
export const MAX_IN_FLIGHT_EXTRACTS = 1

const IN_FLIGHT = ['pending', 'claimed', 'running'] as const

/** How many extraction jobs this student already has waiting on the GPU. */
export async function inFlightExtractCount(db: Db, userId: string): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.userId, userId),
        eq(processingJobs.stage, 'extract'),
        eq(processingJobs.executor, 'operator_gpu'),
        inArray(processingJobs.status, IN_FLIGHT),
      ),
    )

  return Number(row?.count ?? 0)
}

export async function enqueueJob(db: Db, args: EnqueueArgs): Promise<string> {
  const [row] = await db
    .insert(processingJobs)
    .values({
      worksheetId: args.worksheetId,
      userId: args.userId,
      stage: args.stage,
      executor: args.executor,
      priority: args.priority ?? 'normal',
      status: 'pending',
      checkpoint: args.checkpoint ?? null,
    })
    .returning({ id: processingJobs.id })

  return row.id
}

/**
 * An explain job already waiting for this question, if there is one.
 *
 * Clicking twice while the worker is busy should join the queue once rather
 * than book the GPU twice for the same answer.
 */
export async function pendingExplainJob(
  db: Db,
  userId: string,
  questionId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.userId, userId),
        eq(processingJobs.stage, 'explain'),
        sql`${processingJobs.status} in ('pending', 'running')`,
        sql`${processingJobs.checkpoint} ->> 'questionId' = ${questionId}`,
      ),
    )
    .limit(1)

  return row?.id ?? null
}

export interface ClaimedJob {
  id: string
  worksheetId: string
  userId: string
  /**
   * Read back as the column's own type rather than the enqueueable one: a row
   * written before the narrowing above can still be holding either of the two
   * labels nothing enqueues any more.
   */
  stage: StoredJobStage
  attemptCount: number
  checkpoint: Record<string, unknown> | null
}

export async function claimJob(
  db: Db,
  executor: JobExecutor,
  workerId: string | null = null,
  now: Date = new Date(),
): Promise<ClaimedJob | null> {
  const staleBefore = new Date(now.getTime() - CLAIM_TTL_MS).toISOString()
  const claimedAt = now.toISOString()

  const result = await db.execute(sql`
    with next_job as (
      select id
      from ${processingJobs}
      where ${processingJobs.executor} = ${executor}
        and ${processingJobs.attemptCount} < ${MAX_ATTEMPTS}
        and (
          ${processingJobs.status} = 'pending'
          or (
            ${processingJobs.status} in ('claimed', 'running')
            and ${processingJobs.claimedAt} < ${staleBefore}::timestamptz
          )
        )
      order by
        case ${processingJobs.priority}
          when 'high' then 0
          when 'normal' then 1
          else 2
        end,
        ${processingJobs.createdAt}
      limit 1
      for update skip locked
    )
    update ${processingJobs} as j
    set status = 'claimed',
        claimed_by = ${workerId},
        claimed_at = ${claimedAt}::timestamptz,
        attempt_count = j.attempt_count + 1
    from next_job
    where j.id = next_job.id
    returning j.id, j.worksheet_id, j.user_id, j.stage, j.attempt_count, j.checkpoint
  `)

  const rows = unwrapDriverRows<{
    id: string
    worksheet_id: string
    user_id: string
    stage: StoredJobStage
    attempt_count: number
    checkpoint: Record<string, unknown> | null
  }>(result)

  const row = rows[0]
  if (!row) return null

  return {
    id: row.id,
    worksheetId: row.worksheet_id,
    userId: row.user_id,
    stage: row.stage,
    attemptCount: Number(row.attempt_count),
    checkpoint: row.checkpoint,
  }
}

export async function checkpointJob(
  db: Db,
  jobId: string,
  progress: number,
  checkpoint: Record<string, unknown>,
): Promise<void> {
  await db
    .update(processingJobs)
    .set({
      status: 'running',
      progress: Math.max(0, Math.min(1, progress)),
      checkpoint,
      claimedAt: new Date(),
    })
    .where(eq(processingJobs.id, jobId))
}

export async function completeJob(db: Db, jobId: string): Promise<void> {
  await db
    .update(processingJobs)
    .set({ status: 'completed', progress: 1, completedAt: new Date(), error: null })
    .where(eq(processingJobs.id, jobId))
}

export async function failJob(
  db: Db,
  jobId: string,
  message: string,
  force = false,
): Promise<{ permanent: boolean }> {
  const [row] = await db
    .select({ attemptCount: processingJobs.attemptCount })
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId))
    .limit(1)

  // `force` is for a failure retrying can never fix, e.g. Tier B discovering
  // the student's API key is gone. Spreading that over the normal 3-attempt
  // retry schedule just delays the student seeing it and wastes claims on a
  // job that was never going to succeed.
  const permanent = force || (row?.attemptCount ?? MAX_ATTEMPTS) >= MAX_ATTEMPTS

  await db
    .update(processingJobs)
    .set({
      status: permanent ? 'failed' : 'pending',
      error: message.slice(0, 2000),
      claimedBy: null,
      claimedAt: null,
      ...(permanent ? { completedAt: new Date() } : {}),
    })
    .where(eq(processingJobs.id, jobId))

  return { permanent }
}

export interface AbandonedJob {
  id: string
  stage: string
  userId: string
  worksheetId: string
}

/**
 * Fails jobs no worker can ever pick up again.
 *
 * `attempt_count` increments on the claim, not on the failure, and `claimJob`
 * refuses anything at `MAX_ATTEMPTS`. So a worker that dies on its third claim,
 * before it can report anything, leaves the row `claimed` forever: past the
 * retry ceiling, so unclaimable, and nothing but a worker ever marks a job
 * failed. The student's worksheet sits at "Queued" for good and the trial
 * credit it charged is never given back.
 *
 * Claimed past the TTL, so a worker that is merely slow is not swept out from
 * under itself: this only touches jobs whose claim has already expired and
 * which `claimJob` has therefore already stopped considering.
 *
 * Returns what it failed rather than doing the refund itself, because refunding
 * is `applyPermanentFailure`'s job and that lives with the worker code. Same
 * path a reported failure takes, so a job that dies silently and one that dies
 * loudly leave the account in the same state.
 */
export async function reapAbandonedJobs(
  db: Db,
  now: Date = new Date(),
): Promise<AbandonedJob[]> {
  const staleBefore = new Date(now.getTime() - CLAIM_TTL_MS)

  const reaped = await db
    .update(processingJobs)
    .set({
      status: 'failed',
      error: 'The worker stopped responding and the job ran out of attempts.',
      claimedBy: null,
      claimedAt: null,
      completedAt: now,
    })
    .where(
      and(
        inArray(processingJobs.status, ['claimed', 'running']),
        lt(processingJobs.claimedAt, staleBefore),
        gte(processingJobs.attemptCount, MAX_ATTEMPTS),
      ),
    )
    .returning({
      id: processingJobs.id,
      stage: processingJobs.stage,
      userId: processingJobs.userId,
      worksheetId: processingJobs.worksheetId,
    })

  return reaped
}

export interface QueueDepth {
  pending: number
  running: number
  oldestPendingAt: Date | null
}

export async function queueDepth(
  db: Db,
  executor: JobExecutor,
): Promise<QueueDepth> {
  const [row] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${processingJobs.status} = 'pending')::int`,
      running: sql<number>`count(*) filter (where ${processingJobs.status} in ('claimed','running'))::int`,
      oldest: sql<Date | null>`min(${processingJobs.createdAt}) filter (where ${processingJobs.status} = 'pending')`,
    })
    .from(processingJobs)
    .where(eq(processingJobs.executor, executor))

  return {
    pending: Number(row?.pending ?? 0),
    running: Number(row?.running ?? 0),
    oldestPendingAt: row?.oldest ? new Date(row.oldest) : null,
  }
}

export async function heartbeat(
  db: Db,
  name: string,
  modelName: string | null,
  jobsInFlight = 0,
): Promise<string> {
  const [row] = await db
    .insert(gpuWorkers)
    .values({
      name,
      modelName,
      status: 'online',
      jobsInFlight,
      lastHeartbeatAt: new Date(),
    })
    .onConflictDoUpdate({
      target: gpuWorkers.name,
      set: {
        modelName,
        status: 'online',
        jobsInFlight,
        lastHeartbeatAt: new Date(),
      },
    })
    .returning({ id: gpuWorkers.id })

  return row.id
}

export interface WorkerStatus {
  online: boolean
  name: string | null
  modelName: string | null
  lastHeartbeatAt: Date | null
}

export async function workerStatus(
  db: Db,
  now: Date = new Date(),
): Promise<WorkerStatus> {
  const [row] = await db
    .select()
    .from(gpuWorkers)
    .orderBy(sql`${gpuWorkers.lastHeartbeatAt} desc nulls last`)
    .limit(1)

  if (!row) {
    return { online: false, name: null, modelName: null, lastHeartbeatAt: null }
  }

  const fresh =
    row.lastHeartbeatAt !== null &&
    now.getTime() - row.lastHeartbeatAt.getTime() < HEARTBEAT_TTL_MS

  return {
    online: fresh && row.status === 'online',
    name: row.name,
    modelName: row.modelName,
    lastHeartbeatAt: row.lastHeartbeatAt,
  }
}

export async function markWorkerOffline(db: Db, name: string): Promise<void> {
  await db
    .update(gpuWorkers)
    .set({ status: 'offline', jobsInFlight: 0 })
    .where(eq(gpuWorkers.name, name))
}
