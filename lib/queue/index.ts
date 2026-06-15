import { and, eq, sql } from 'drizzle-orm'

import type { Db } from '@/lib/dashboard/queries'
import { gpuWorkers, processingJobs } from '@/lib/db/schema'

/**
 * Postgres-backed durable queue (spec §3.3, §4).
 *
 * Shared by Tier B server jobs and the Tier 0 operator GPU worker, which are
 * separated only by the `executor` discriminator. Claiming uses
 * FOR UPDATE SKIP LOCKED so multiple workers can drain it concurrently.
 */

export type JobExecutor = 'server' | 'browser' | 'operator_gpu'
export type JobStage = 'extract' | 'answer_key' | 'classify' | 'explain'
export type JobPriority = 'high' | 'normal' | 'low'

export const MAX_ATTEMPTS = 3

/** How long a claim is honoured before another worker may reclaim it. */
export const CLAIM_TTL_MS = 15 * 60_000

/** A worker is considered offline this long after its last heartbeat. */
export const HEARTBEAT_TTL_MS = 90_000

export interface EnqueueArgs {
  worksheetId: string
  userId: string
  stage: JobStage
  executor: JobExecutor
  priority?: JobPriority
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
    })
    .returning({ id: processingJobs.id })

  return row.id
}

export interface ClaimedJob {
  id: string
  worksheetId: string
  userId: string
  stage: JobStage
  attemptCount: number
  checkpoint: Record<string, unknown> | null
}

/**
 * Atomically claims one job.
 *
 * Priority ordering is `high` → `normal` → `low`, then oldest first, so an
 * admin's unlimited-length upload (queued `low`) yields to trial users
 * (spec §2.1). Jobs whose claim has expired are reclaimed, which is what makes
 * a dead worker recoverable rather than a permanent stall.
 */
export async function claimJob(
  db: Db,
  executor: JobExecutor,
  workerId: string | null = null,
  now: Date = new Date(),
): Promise<ClaimedJob | null> {
  // ISO strings, not Date objects: raw sql`` fragments bypass the column
  // mappers, and postgres.js refuses to serialize a bare Date there (PGlite's
  // driver accepts them, which is why tests alone didn't catch this).
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

  const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows) as
    | {
        id: string
        worksheet_id: string
        user_id: string
        stage: JobStage
        attempt_count: number
        checkpoint: Record<string, unknown> | null
      }[]
    | undefined

  const row = rows?.[0]
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

/** Per-page progress so a dead worker or closed tab resumes, not restarts. */
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

/**
 * Records a failure. Returns true when the job is permanently dead, which is
 * the signal to refund trial quota (spec §12 assumption 9).
 */
export async function failJob(
  db: Db,
  jobId: string,
  message: string,
): Promise<{ permanent: boolean }> {
  const [row] = await db
    .select({ attemptCount: processingJobs.attemptCount })
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId))
    .limit(1)

  const permanent = (row?.attemptCount ?? MAX_ATTEMPTS) >= MAX_ATTEMPTS

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

/* -------------------------------------------------------------------------- */
/* Worker registry                                                            */
/* -------------------------------------------------------------------------- */

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

/**
 * Drives the "queued — we'll notify you" state on the upload screen. A stale
 * heartbeat means the operator's machine is asleep, not that jobs are lost.
 */
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
    .where(and(eq(gpuWorkers.name, name)))
}
