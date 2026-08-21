import { and, count, desc, eq, gte, inArray, lt, notExists, or, sql } from 'drizzle-orm'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { storage } from '@/lib/storage'

import { type Db, unwrapDriverRows } from '@/lib/db/types'
import {
  gpuWorkers,
  processingJobs,
  users,
  worksheetPages,
  worksheets,
} from '@/lib/db/schema'

export type JobExecutor = 'server' | 'browser' | 'operator_gpu'

export type JobStage = 'extract' | 'explain' | 'answer_key' | 'classify'

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
  checkpoint?: Record<string, unknown>
}

export const MAX_IN_FLIGHT_EXTRACTS = 1

const IN_FLIGHT = ['pending', 'claimed', 'running'] as const

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
        inArray(processingJobs.status, IN_FLIGHT),
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
  userId: string | null = null,
  stages: JobStage[] | null = null,
): Promise<ClaimedJob | null> {
  const staleBefore = new Date(now.getTime() - CLAIM_TTL_MS).toISOString()
  const claimedAt = now.toISOString()
  const wanted = stages?.length ? stages.join(',') : null

  const result = await db.execute(sql`
    with next_job as (
      select id
      from ${processingJobs}
      where ${processingJobs.executor} = ${executor}
        and ${processingJobs.attemptCount} < ${MAX_ATTEMPTS}
        and (${userId}::text is null or ${processingJobs.userId} = ${userId})
        and (
          ${wanted}::text is null
          or ${processingJobs.stage}::text = any(string_to_array(${wanted}, ','))
        )
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
    stage: JobStage
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

export async function touchJob(db: Db, jobId: string): Promise<void> {
  await db
    .update(processingJobs)
    .set({ status: 'running', claimedAt: new Date() })
    .where(
      and(
        eq(processingJobs.id, jobId),
        inArray(processingJobs.status, ['claimed', 'running']),
      ),
    )
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
  stage: JobStage
  userId: string
  worksheetId: string
}

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
  onlineCount: number
  name: string | null
  modelName: string | null
  lastHeartbeatAt: Date | null
}

const WORKERS_CONSIDERED = 50

export async function workerStatus(
  db: Db,
  now: Date = new Date(),
): Promise<WorkerStatus> {
  const rows = await db
    .select()
    .from(gpuWorkers)
    .orderBy(sql`${gpuWorkers.lastHeartbeatAt} desc nulls last`)
    .limit(WORKERS_CONSIDERED)

  const live = rows.filter(
    (row) =>
      row.status === 'online' &&
      row.lastHeartbeatAt !== null &&
      now.getTime() - row.lastHeartbeatAt.getTime() < HEARTBEAT_TTL_MS,
  )

  const representative = live[0] ?? rows[0] ?? null

  return {
    online: live.length > 0,
    onlineCount: live.length,
    name: representative?.name ?? null,
    modelName: representative?.modelName ?? null,
    lastHeartbeatAt: representative?.lastHeartbeatAt ?? null,
  }
}

export async function markWorkerOffline(db: Db, name: string): Promise<void> {
  await db
    .update(gpuWorkers)
    .set({ status: 'offline', jobsInFlight: 0 })
    .where(eq(gpuWorkers.name, name))
}

export interface ActionableJob {
  id: string
  worksheetId: string
  userId: string
  userEmail: string | null
  stage: JobStage
  executor: JobExecutor
  status: (typeof processingJobs.$inferSelect)['status']
  attemptCount: number
  error: string | null
  claimedAt: Date | null
  createdAt: Date
}

const ACTIONABLE_STATUSES = ['claimed', 'running', 'failed', 'cancelled'] as const

export async function listActionableJobs(db: Db, limit = 50): Promise<ActionableJob[]> {
  return db
    .select({
      id: processingJobs.id,
      worksheetId: processingJobs.worksheetId,
      userId: processingJobs.userId,
      userEmail: users.email,
      stage: processingJobs.stage,
      executor: processingJobs.executor,
      status: processingJobs.status,
      attemptCount: processingJobs.attemptCount,
      error: processingJobs.error,
      claimedAt: processingJobs.claimedAt,
      createdAt: processingJobs.createdAt,
    })
    .from(processingJobs)
    .innerJoin(users, eq(users.id, processingJobs.userId))
    .where(inArray(processingJobs.status, ACTIONABLE_STATUSES))
    .orderBy(desc(processingJobs.createdAt))
    .limit(limit)
}

export async function cancelJob(
  db: Db,
  jobId: string,
  message = 'Cancelled by an admin.',
): Promise<AbandonedJob | null> {
  const [cancelled] = await db
    .update(processingJobs)
    .set({
      status: 'cancelled',
      error: message,
      claimedBy: null,
      claimedAt: null,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(processingJobs.id, jobId),
        inArray(processingJobs.status, ['pending', 'claimed', 'running']),
      ),
    )
    .returning({
      id: processingJobs.id,
      stage: processingJobs.stage,
      userId: processingJobs.userId,
      worksheetId: processingJobs.worksheetId,
    })

  return cancelled ?? null
}

export async function requeueJob(db: Db, jobId: string): Promise<boolean> {
  const [job] = await db
    .update(processingJobs)
    .set({
      status: 'pending',
      attemptCount: 0,
      error: null,
      claimedBy: null,
      claimedAt: null,
      completedAt: null,
    })
    .where(
      and(eq(processingJobs.id, jobId), inArray(processingJobs.status, ['failed', 'cancelled'])),
    )
    .returning({ id: processingJobs.id, worksheetId: processingJobs.worksheetId })

  if (!job) return false

  await transitionWorksheet(db, job.worksheetId, ['failed'], { status: 'queued' })

  return true
}

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

export type Guarded =
  | { ok: true; userId: string; role: 'student' | 'admin' }
  | { ok: false; status: 401 | 404 }

export async function guardWorksheet(worksheetId: string): Promise<Guarded> {
  const session = await auth()
  if (!session?.user?.id) return { ok: false, status: 401 }

  const [worksheet] = await db
    .select({ userId: worksheets.userId })
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  if (!worksheet || worksheet.userId !== session.user.id) {
    return { ok: false, status: 404 }
  }

  return { ok: true, userId: session.user.id, role: session.user.role }
}

export const ABANDONED_AFTER_MS = 60 * 60_000

export async function sweepAbandonedUploads(
  db: Db,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - ABANDONED_AFTER_MS)

  const stale = await db
    .select({ id: worksheets.id })
    .from(worksheets)
    .where(
      and(
        eq(worksheets.userId, userId),
        lt(worksheets.createdAt, cutoff),
        or(
          eq(worksheets.status, 'uploading'),
          and(
            eq(worksheets.status, 'processing'),
            notExists(
              db
                .select({ one: sql`1` })
                .from(processingJobs)
                .where(eq(processingJobs.worksheetId, worksheets.id)),
            ),
          ),
        ),
      ),
    )

  if (stale.length === 0) return 0

  for (const sheet of stale) {
    const pages = await db
      .select({ imageKey: worksheetPages.imageKey })
      .from(worksheetPages)
      .where(eq(worksheetPages.worksheetId, sheet.id))

    await db.delete(worksheets).where(eq(worksheets.id, sheet.id))

    await Promise.allSettled(pages.map((page) => storage.remove(page.imageKey)))
  }

  return stale.length
}
