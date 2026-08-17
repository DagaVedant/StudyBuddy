import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { MockProvider } from '@/lib/ai/mock'
import { validated } from '@/lib/ai/validated'
import type { ResolvedProvider } from '@/lib/ai/resolve'
import type { Db } from '@/lib/db/types'
import { worksheetPages, worksheets } from '@/lib/db/schema'
import { enqueueJob } from '@/lib/queue'
import { storage } from '@/lib/storage'
import { drainServerQueue } from '@/lib/worker/server-job'

import { createTestDb, type TestDb } from '../helpers/db'
import { makeUser, makeWorksheet } from '../helpers/factories'

vi.mock('@/lib/classify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/classify')>()
  return {
    ...actual,
    classifyWorksheet: vi.fn(async () => {
      throw new actual.EmbeddingUnavailableError('onnxruntime-node failed to load')
    }),
  }
})

let db: TestDb
let close: () => Promise<void>

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
  provider: validated(new MockProvider()),
  tier: 'cloud',
  executor: 'server',
})

async function setup() {
  const userId = await makeUser(db)
  const worksheetId = await makeWorksheet(db, userId)
  await db.update(worksheets).set({ status: 'queued' }).where(eq(worksheets.id, worksheetId))

  const key = `test-pages/${worksheetId}.png`
  const onePixelPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  )
  await storage.put(key, onePixelPng, 'image/png')
  written.push(key)

  await db.insert(worksheetPages).values({
    worksheetId,
    pageNumber: 1,
    imageKey: key,
    ocrText: '1. What is 2 + 2?',
  })

  return { userId, worksheetId }
}

/*
 * Findings 8 / 106. A server log saying "CLASSIFICATION IS OFF" fixed the
 * deployment side of an embedding-model failure and left the student side
 * exactly as silent as before: the worksheet still completed, still reached
 * `awaiting_review`, and nothing on the one screen it actually lands on said
 * why every question came back untagged.
 */
describe('drainServerQueue records a classification failure the student can see', () => {
  it('completes the job and writes a reason onto the worksheet', async () => {
    const { userId, worksheetId } = await setup()
    await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'server',
    })

    await drainServerQueue(db as Db, 10, asServer)

    const [worksheet] = await db
      .select({ status: worksheets.status, classificationError: worksheets.classificationError })
      .from(worksheets)
      .where(eq(worksheets.id, worksheetId))

    // Still reaches the student. Extraction and the repair passes are real
    // work regardless of what classification could do, and failing the whole
    // job over it would take that away for nothing.
    expect(worksheet.status).toBe('awaiting_review')
    expect(worksheet.classificationError).toContain('unavailable')
  })

  it('leaves classificationError null when classification succeeds', async () => {
    vi.mocked((await import('@/lib/classify')).classifyWorksheet).mockImplementationOnce(
      async () => ({ classified: 0, coarse: 0, failed: 0 }),
    )

    const { userId, worksheetId } = await setup()
    await enqueueJob(db as Db, {
      worksheetId,
      userId,
      stage: 'extract',
      executor: 'server',
    })

    await drainServerQueue(db as Db, 10, asServer)

    const [worksheet] = await db
      .select({ classificationError: worksheets.classificationError })
      .from(worksheets)
      .where(eq(worksheets.id, worksheetId))

    expect(worksheet.classificationError).toBeNull()
  })
})
