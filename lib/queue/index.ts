import { and, eq, sql } from 'drizzle-orm'

import type { Db } from '@/lib/dashboard/queries'
import { gpuWorkers, processingJobs } from '@/lib/db/schema'

export type JobExecutor = 'server' | 'browser' | 'operator_gpu'
export type JobStage = 'extract' | 'answer_key' | 'classify' | 'explain'
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
  stage: JobStage
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

  // `force` is for a failure retrying can never fix — e.g. Tier B discovering
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
    .where(and(eq(gpuWorkers.name, name)))
}
