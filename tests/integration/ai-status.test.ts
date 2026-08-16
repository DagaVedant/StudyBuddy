import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getAiStatus, shouldOfferAiSetup } from '@/lib/ai/resolve'
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
 * Read from the credentials table rather than from `resolveProvider`'s `tier`,
 * which answers the nearby question "what runs the next upload". The two agree
 * now that resolution has an Ollama branch; they did not when this was written,
 * and the disagreement is what these tests were guarding: this label said
 * "Ollama connected" while resolution could not see an Ollama row, so the
 * dashboard named a tier no upload would ever use. Staying on the credentials
 * table keeps it answering what the account is set up with, which is what
 * spec.md:398 asks the strip to carry.
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

/**
 * spec.md:339 asks for the AI setup choice at two moments, and only the second
 * one, settings, existed. Which meant a student met the end of their trial on
 * the completion route, as a message explaining they had already been dropped
 * to the manual editor.
 */
describe('shouldOfferAiSetup', () => {
  async function statusAfterUsing(worksheets: number) {
    const userId = await makeUser(db)
    await db
      .update(users)
      .set({ trialWorksheetsUsed: worksheets })
      .where(eq(users.id, userId))

    return getAiStatus(client(), userId)
  }

  it('offers the choice with one worksheet left', async () => {
    expect(shouldOfferAiSetup(await statusAfterUsing(2))).toBe(true)
  })

  it('stays quiet while there is more than one left', async () => {
    expect(shouldOfferAiSetup(await statusAfterUsing(0))).toBe(false)
    expect(shouldOfferAiSetup(await statusAfterUsing(1))).toBe(false)
  })

  /**
   * Zero is not "running low", it is over, and the two want different words.
   * A card headed "One trial worksheet left" on an account with none is worse
   * than no card: it reads as an offer that has already expired.
   */
  it('stays quiet once the trial is spent', async () => {
    expect(shouldOfferAiSetup(await statusAfterUsing(3))).toBe(false)
  })

  it('stays quiet for an account that already has a provider', async () => {
    const userId = await makeUser(db)
    await db.update(users).set({ trialWorksheetsUsed: 2 }).where(eq(users.id, userId))
    await db.insert(userAiCredentials).values({
      userId,
      provider: 'ollama',
      ollamaBaseUrl: 'http://127.0.0.1:11434',
    })

    // The count is still 1 in the users row. What makes this quiet is that a
    // configured account reports null rather than a number, so "one left"
    // cannot be read off an account the trial no longer applies to.
    const status = await getAiStatus(client(), userId)

    expect(status.trialWorksheetsRemaining).toBeNull()
    expect(shouldOfferAiSetup(status)).toBe(false)
  })
})
