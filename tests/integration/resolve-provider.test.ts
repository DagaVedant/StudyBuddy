import { randomBytes } from 'node:crypto'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { sealApiKey } from '@/lib/ai/crypto'
import { TRIAL_WORKSHEET_LIMIT } from '@/lib/ai/limits'
import { resolveProvider, type CloudProvider } from '@/lib/ai/resolve'
import { userAiCredentials, users } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

import { asDb, createTestDb, type TestDb } from '../helpers/db'
import { makeUser } from '../helpers/factories'

let db: TestDb
let close: () => Promise<void>

let previousKey: string | undefined

beforeAll(async () => {
  const created = await createTestDb()
  db = created.db
  close = created.close

  previousKey = process.env.CREDENTIALS_ENC_KEY
  process.env.CREDENTIALS_ENC_KEY = randomBytes(32).toString('base64')
})

afterAll(async () => {
  process.env.CREDENTIALS_ENC_KEY = previousKey
  await close()
})

const original = process.env.ENABLE_MOCK_AI

afterEach(() => {
  if (original === undefined) delete process.env.ENABLE_MOCK_AI
  else process.env.ENABLE_MOCK_AI = original
})

const client = () => asDb(db)

async function withCloudKey(userId: string, provider: CloudProvider = 'anthropic') {
  const sealed = sealApiKey('sk-ant-not-a-real-key-0123456789')

  await db.insert(userAiCredentials).values({
    userId,
    provider,
    keyLast4: sealed.last4,
    encryptedKey: sealed.ciphertext,
    keyIv: sealed.iv,
    keyAuthTag: sealed.authTag,
  })
}

describe('resolveProvider', () => {
  it('starts a new account on the trial, running on the operator GPU', async () => {
    const userId = await makeUser(db)

    expect(await resolveProvider(client(), userId)).toMatchObject({
      tier: 'trial',
      executor: 'operator_gpu',
    })
  })

  it('keeps them there until the last free worksheet is used', async () => {
    const userId = await makeUser(db)
    await db
      .update(users)
      .set({ trialWorksheetsUsed: TRIAL_WORKSHEET_LIMIT - 1 })
      .where(eq(users.id, userId))

    expect((await resolveProvider(client(), userId)).tier).toBe('trial')
  })

  it('drops to free with nothing to run on once the trial is spent', async () => {
    const userId = await makeUser(db)
    await db
      .update(users)
      .set({ trialWorksheetsUsed: TRIAL_WORKSHEET_LIMIT })
      .where(eq(users.id, userId))

    expect(await resolveProvider(client(), userId)).toMatchObject({
      tier: 'free',
      executor: 'none',
    })
  })

  it('does not drop an admin, however many they have processed', async () => {
    const userId = await makeUser(db)
    await db
      .update(users)
      .set({ role: 'admin', trialWorksheetsUsed: TRIAL_WORKSHEET_LIMIT * 100 })
      .where(eq(users.id, userId))

    expect(await resolveProvider(client(), userId)).toMatchObject({
      tier: 'trial',
      executor: 'operator_gpu',
    })
  })

  it('treats a user id with no row as a new account', async () => {
    expect((await resolveProvider(client(), 'nobody')).tier).toBe('trial')
  })

  describe('with a saved cloud key', () => {
    it('routes to the cloud, on the server', async () => {
      delete process.env.ENABLE_MOCK_AI
      const userId = await makeUser(db)
      await withCloudKey(userId)

      expect(await resolveProvider(client(), userId)).toMatchObject({
        tier: 'cloud',
        executor: 'server',
      })
    })

    it('decrypts the key rather than taking the mock path', async () => {
      delete process.env.ENABLE_MOCK_AI
      const userId = await makeUser(db)
      await withCloudKey(userId)

      const resolved = await resolveProvider(client(), userId)

      expect(resolved.provider.name).toBe('anthropic')
    })

    it('throws rather than falling back when the stored key cannot be opened', async () => {
      delete process.env.ENABLE_MOCK_AI
      const userId = await makeUser(db)
      await withCloudKey(userId)
      await db
        .update(userAiCredentials)
        .set({ keyAuthTag: Buffer.alloc(16).toString('base64') })
        .where(eq(userAiCredentials.userId, userId))

      await expect(resolveProvider(client(), userId)).rejects.toThrow()
    })

    it('takes the mock when the flag is set, and still calls it cloud', async () => {
      process.env.ENABLE_MOCK_AI = 'true'
      const userId = await makeUser(db)
      await withCloudKey(userId)

      const resolved = await resolveProvider(client(), userId)

      expect(resolved.tier).toBe('cloud')
      expect(resolved.provider.name).toBe('mock')
    })

    it('ignores a row that has no key on it', async () => {
      delete process.env.ENABLE_MOCK_AI
      const userId = await makeUser(db)
      await db.insert(userAiCredentials).values({
        userId,
        provider: 'anthropic',
        keyLast4: '1234',
      })

      expect((await resolveProvider(client(), userId)).tier).toBe('trial')
    })

    it('beats the admin branch, so an admin with a key uses it', async () => {
      delete process.env.ENABLE_MOCK_AI
      const userId = await makeUser(db)
      await db.update(users).set({ role: 'admin' }).where(eq(users.id, userId))
      await withCloudKey(userId)

      expect((await resolveProvider(client(), userId)).tier).toBe('cloud')
    })
  })

  it.each(['openai', 'openrouter', 'google'] as const)(
    'builds a %s provider from a stored key',
    async (provider) => {
      delete process.env.ENABLE_MOCK_AI
      const userId = await makeUser(db)
      await withCloudKey(userId, provider)

      expect((await resolveProvider(client(), userId)).provider.name).toBe(provider)
    },
  )

  describe('with a saved ollama address', () => {
    async function withOllama(userId: string) {
      await db.insert(userAiCredentials).values({
        userId,
        provider: 'ollama',
        ollamaBaseUrl: 'http://localhost:11434',
      })
    }

    it('routes to the browser, which is the only thing that can reach it', async () => {
      delete process.env.ENABLE_MOCK_AI
      const userId = await makeUser(db)
      await withOllama(userId)

      expect(await resolveProvider(client(), userId)).toMatchObject({
        tier: 'ollama',
        executor: 'browser',
      })
    })

    it('hands back a provider that refuses, since nothing here can run it', async () => {
      delete process.env.ENABLE_MOCK_AI
      const userId = await makeUser(db)
      await withOllama(userId)

      const resolved = await resolveProvider(client(), userId)

      expect(resolved.provider.name).toBe('null')
      expect(resolved.provider.executionSite).toBe('none')
    })

    it('beats the trial, so configuring it does not quietly spend a credit', async () => {
      delete process.env.ENABLE_MOCK_AI
      const userId = await makeUser(db)
      await withOllama(userId)

      expect((await resolveProvider(client(), userId)).tier).toBe('ollama')
    })

    it('loses to a cloud key, which needs no tab held open', async () => {
      delete process.env.ENABLE_MOCK_AI
      const userId = await makeUser(db)
      await withOllama(userId)
      await withCloudKey(userId)

      expect((await resolveProvider(client(), userId)).tier).toBe('cloud')
    })

    it('ignores a row with no address on it', async () => {
      delete process.env.ENABLE_MOCK_AI
      const userId = await makeUser(db)
      await db.insert(userAiCredentials).values({ userId, provider: 'ollama' })

      expect((await resolveProvider(client(), userId)).tier).toBe('trial')
    })

    it('runs server-side under the mock flag, still called ollama', async () => {
      process.env.ENABLE_MOCK_AI = 'true'
      const userId = await makeUser(db)
      await withOllama(userId)

      expect(await resolveProvider(client(), userId)).toMatchObject({
        tier: 'ollama',
        executor: 'server',
      })
    })
  })
})
