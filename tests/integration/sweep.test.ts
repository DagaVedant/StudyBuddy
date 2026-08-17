import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Db } from '@/lib/db/types'
import { processingJobs, worksheetPages, worksheets } from '@/lib/db/schema'
import { enqueueJob } from '@/lib/queue'
import { ABANDONED_AFTER_MS, sweepAbandonedUploads } from '@/lib/upload/sweep'

import { createTestDb, type TestDb } from '../helpers/db'
import { makeUser, makeWorksheet } from '../helpers/factories'

let db: TestDb
let close: () => Promise<void>

beforeAll(async () => {
  const created = await createTestDb()
  db = created.db
  close = created.close
})

afterAll(async () => {
  await close()
})

const client = () => db as unknown as Db

const HOURS_AGO = (n: number) => new Date(Date.now() - n * 60 * 60_000)

async function stale(
  userId: string,
  status: 'uploading' | 'processing' | 'ready' | 'failed',
  createdAt: Date,
): Promise<string> {
  const id = await makeWorksheet(db, userId)
  await db.update(worksheets).set({ status, createdAt }).where(eq(worksheets.id, id))
  return id
}

async function addPage(worksheetId: string): Promise<void> {
  await db.insert(worksheetPages).values({
    worksheetId,
    pageNumber: 1,
    imageKey: `pages/${worksheetId}-1.png`,
  })
}

async function survives(worksheetId: string): Promise<boolean> {
  const rows = await db
    .select({ id: worksheets.id })
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
  return rows.length > 0
}

describe('sweepAbandonedUploads', () => {
  it('reclaims an upload that never got a page', async () => {
    const userId = await makeUser(db)
    const abandoned = await stale(userId, 'uploading', HOURS_AGO(2))

    expect(await sweepAbandonedUploads(client(), userId)).toBe(1)
    expect(await survives(abandoned)).toBe(false)
  })

  it('reclaims an upload abandoned partway through its pages', async () => {
    const userId = await makeUser(db)
    const abandoned = await stale(userId, 'processing', HOURS_AGO(2))
    await addPage(abandoned)

    expect(await sweepAbandonedUploads(client(), userId)).toBe(1)
    expect(await survives(abandoned)).toBe(false)
  })

  it('leaves a worksheet alone once something is queued for it', async () => {
    const userId = await makeUser(db)
    const real = await stale(userId, 'processing', HOURS_AGO(5))
    await addPage(real)
    await enqueueJob(client(), {
      worksheetId: real,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })

    expect(await sweepAbandonedUploads(client(), userId)).toBe(0)
    expect(await survives(real)).toBe(true)
  })

  it('leaves a job that already failed, so the student can still see it', async () => {
    const userId = await makeUser(db)
    const failed = await stale(userId, 'processing', HOURS_AGO(5))
    const jobId = await enqueueJob(client(), {
      worksheetId: failed,
      userId,
      stage: 'extract',
      executor: 'operator_gpu',
    })
    await db
      .update(processingJobs)
      .set({ status: 'failed' })
      .where(eq(processingJobs.id, jobId))

    expect(await sweepAbandonedUploads(client(), userId)).toBe(0)
    expect(await survives(failed)).toBe(true)
  })

  it('leaves an upload still inside the window', async () => {
    const userId = await makeUser(db)
    const recent = await stale(userId, 'processing', new Date(Date.now() - ABANDONED_AFTER_MS / 2))
    await addPage(recent)

    expect(await sweepAbandonedUploads(client(), userId)).toBe(0)
    expect(await survives(recent)).toBe(true)
  })

  it('leaves finished and failed worksheets whatever their age', async () => {
    const userId = await makeUser(db)
    const ready = await stale(userId, 'ready', HOURS_AGO(500))
    const failed = await stale(userId, 'failed', HOURS_AGO(500))

    expect(await sweepAbandonedUploads(client(), userId)).toBe(0)
    expect(await survives(ready)).toBe(true)
    expect(await survives(failed)).toBe(true)
  })

  it('never reaches another student’s uploads', async () => {
    const mine = await makeUser(db)
    const theirs = await makeUser(db)
    const foreign = await stale(theirs, 'processing', HOURS_AGO(9))
    await addPage(foreign)

    expect(await sweepAbandonedUploads(client(), mine)).toBe(0)
    expect(await survives(foreign)).toBe(true)
  })
})
