import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getAiStatus } from '@/lib/ai/resolve'
import { userAiCredentials, users } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'

import { createTestDb, type TestDb } from '../helpers/db'
import { makeUser } from '../helpers/factories'

let db: TestDb
let close: () => Promise<void>

beforeAll(async () => {
  const harness = await createTestDb()
  db = harness.db
  close = harness.close
})

afterAll(async () => {
  await close()
})

const client = () => db as unknown as Db

/*
 * Deliberately not built from `resolveProvider`'s `tier`, which answers "what
 * runs the next upload on the server" and has no branch for Ollama at all,
 * since Ollama runs in the student's own browser and never reaches
 * server-side resolution. An Ollama-configured account would misreport as
 * trial or free through that path. This reads the credentials table directly,
 * which is what spec.md:398 is actually asking to be shown.
 */
describe('getAiStatus', () => {
  it('reports trial worksheets remaining for a fresh account', async () => {
    const userId = await makeUser(db)
    const status = await getAiStatus(client(), userId)

    expect(status.label).toBe('3 trial worksheets left')
    expect(status.href).toBe('/settings')
  })

  it('reports a cloud provider as connected', async () => {
    const userId = await makeUser(db)
    await db.insert(userAiCredentials).values({
      userId,
      provider: 'anthropic',
      encryptedKey: 'x',
      keyIv: 'x',
      keyAuthTag: 'x',
      keyLast4: '1234',
    })

    expect((await getAiStatus(client(), userId)).label).toBe('Anthropic connected')
  })

  // The account this exists to get right. Nothing in `resolveProvider` ever
  // labels an account this way, so a naive reuse of its tier would have shown
  // "3 trial worksheets left" to a student who had already moved to Ollama.
  it('reports Ollama as connected', async () => {
    const userId = await makeUser(db)
    await db.insert(userAiCredentials).values({
      userId,
      provider: 'ollama',
      ollamaBaseUrl: 'http://127.0.0.1:11434',
    })

    expect((await getAiStatus(client(), userId)).label).toBe('Ollama connected')
  })

  it('reports no AI configured once the trial is exhausted and nothing is set up', async () => {
    const userId = await makeUser(db)
    await db.update(users).set({ trialWorksheetsUsed: 3 }).where(eq(users.id, userId))

    expect((await getAiStatus(client(), userId)).label).toBe('No AI configured')
  })

  it('counts down as the trial is used', async () => {
    const userId = await makeUser(db)
    await db.update(users).set({ trialWorksheetsUsed: 2 }).where(eq(users.id, userId))

    expect((await getAiStatus(client(), userId)).label).toBe('1 trial worksheet left')
  })
})
