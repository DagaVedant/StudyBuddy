import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MockProvider } from '@/lib/ai/mock'
import type { ResolvedProvider } from '@/lib/ai/resolve'
import type { Db } from '@/lib/db/types'
import { processingJobs, worksheetPages, worksheets } from '@/lib/db/schema'
import { claimJob, enqueueJob } from '@/lib/queue'
import { storage } from '@/lib/storage'
import { drainServerQueue } from '@/lib/worker/server-job'

import { createTestDb, type TestDb } from '../helpers/db'
import { makeUser, makeWorksheet } from '../helpers/factories'

let db: TestDb
let close: () => Promise<void>

/*
 * These tests write through the real storage driver, which with no blob token
 * configured means real PNGs under .uploads/. Without this, every run left its
 * pages behind: 1,088 files had accumulated before anyone looked.
 */
const written: string[] = []

beforeAll(async () => {
  const harness = await createTestDb()
  db = harness.db
  close = harness.close
})

afterAll(async () => {
  await Promise.all(written.map((key) => storage.remove(key).catch(() => {})))
  await close()
})

const asServer: (db: Db, userId: string) => Promise<ResolvedProvider> = async () => ({
  provider: new MockProvider(),
  tier: 'cloud',
  executor: 'server',
})

async function makePage(worksheetId: string, hasImage: boolean) {
  const key = `test-pages/${worksheetId}.png`
  if (hasImage) {
    // A 1x1 PNG is enough — MockProvider never actually decodes the bytes.
    const onePixelPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    await storage.put(key, onePixelPng, 'image/png')
    written.push(key)
  }

  const [row] = await db
    .insert(worksheetPages)
    .values({
      worksheetId,
      pageNumber: 1,
      imageKey: key,
      ocrText: '1. What is 2 + 2?\n2. What is 3 + 3?',
    })
    .returning({ id: worksheetPages.id })
  return row.id
}

async function setup(hasImage = true) {
  const userId = await makeUser(db)
  const worksheetId = await makeWorksheet(db, userId)
  await makePage(worksheetId, hasImage)
  return { userId, worksheetId }
}

describe('drainServerQueue', () => {
  /*
   * This is the gap the whole module exists to close: nothing polled for
   * `executor: 'server'` jobs, so a Tier B upload (student's own cloud key)
   * enqueued and then sat there forever. Proves a queued job actually gets
   * processed end to end — extracted, classified (against an empty topic
   * set here, which just means every question abstains), and completed —
   * without a second call finding anything left to do.
   */
  it(
    'processes a queued job end to end',
    async () => {
      const { userId, worksheetId } = await setup()
      const jobId = await enqueueJob(db as Db, {
        worksheetId,
        userId,
        stage: 'extract',
        executor: 'server',
      })

      await drainServerQueue(db as Db, 10, asServer)

      const [job] = await db
        .select()
        .from(processingJobs)
        .where(eq(processingJobs.id, jobId))
      expect(job.status).toBe('completed')

      const [worksheet] = await db
        .select({ status: worksheets.status })
        .from(worksheets)
        .where(eq(worksheets.id, worksheetId))
      expect(worksheet.status).toBe('awaiting_review')
    },
    30_000,
  )

  it('leaves nothing behind for a second drain to find', async () => {
    const { userId, worksheetId } = await setup()
    await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'server',
    })

    await drainServerQueue(db as Db, 10, asServer)
    await drainServerQueue(db as Db, 10, asServer)

    expect(await claimJob(db as Db, 'server')).toBeNull()
  })

  it('does nothing on an empty queue', async () => {
    await expect(drainServerQueue(db as Db, 10, asServer)).resolves.toBeUndefined()
  })

  /*
   * A permanent failure must mark the worksheet failed so the student sees
   * it rather than the status page spinning forever — but must NOT touch
   * trial accounting the way the operator_gpu failure path does, since Tier
   * B never draws from the trial in the first place.
   */
  it('marks the worksheet failed on a permanent extraction failure', async () => {
    const { userId, worksheetId } = await setup(false)
    await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'server',
    })

    // The missing page image fails every attempt identically, so one drain
    // (limit 10) burns through all 3 retries on its own before returning.
    await drainServerQueue(db as Db, 10, asServer)

    const [worksheet] = await db
      .select({ status: worksheets.status })
      .from(worksheets)
      .where(eq(worksheets.id, worksheetId))
    expect(worksheet.status).toBe('failed')

    const [job] = await db.select().from(processingJobs).where(eq(processingJobs.userId, userId))
    expect(job.status).toBe('failed')
    expect(job.error).toMatch(/image missing/i)
  })

  it('fails cleanly, without touching the trial, when the key is gone by the time it runs', async () => {
    const { userId, worksheetId } = await setup()
    await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'server',
    })

    const noLongerCloud: typeof asServer = async () => ({
      provider: new MockProvider(),
      tier: 'free',
      executor: 'none',
    })

    await drainServerQueue(db as Db, 10, noLongerCloud)

    const [worksheet] = await db
      .select({ status: worksheets.status })
      .from(worksheets)
      .where(eq(worksheets.id, worksheetId))
    expect(worksheet.status).toBe('failed')

    const [job] = await db.select().from(processingJobs).where(eq(processingJobs.userId, userId))
    expect(job.error).toMatch(/no cloud api key/i)
  })

  it('stops at the drain limit rather than running unbounded', async () => {
    const userId = await makeUser(db)
    const ids: string[] = []

    for (let i = 0; i < 5; i += 1) {
      const worksheetId = await makeWorksheet(db, userId)
      await makePage(worksheetId, true)
      ids.push(
        await enqueueJob(db as Db, {
          worksheetId,
          userId,
          stage: 'extract',
          executor: 'server',
        }),
      )
    }

    await drainServerQueue(db as Db, 2, asServer)

    const statuses = await Promise.all(
      ids.map(async (id) => {
        const [row] = await db
          .select({ status: processingJobs.status })
          .from(processingJobs)
          .where(eq(processingJobs.id, id))
        return row.status
      }),
    )

    expect(statuses.filter((s) => s === 'completed')).toHaveLength(2)
    expect(statuses.filter((s) => s === 'pending')).toHaveLength(3)
  })
})
