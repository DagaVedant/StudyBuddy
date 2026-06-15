import { and, eq } from 'drizzle-orm'

import type { Db } from '@/lib/dashboard/queries'
import { userAiCredentials, users } from '@/lib/db/schema'

import { AnthropicProvider } from './anthropic'
import { openApiKey } from './crypto'
import { MockProvider, NullProvider } from './mock'
import { OllamaProvider } from './ollama'
import { OpenAIProvider } from './openai'
import type { AIProvider } from './types'

export type Tier = 'trial' | 'free' | 'cloud' | 'ollama'

export interface ResolvedProvider {
  provider: AIProvider
  tier: Tier
  /** Where extraction actually happens — decides which queue lane, if any. */
  executor: 'server' | 'browser' | 'operator_gpu' | 'none'
}

export function mockEnabled(): boolean {
  return process.env.ENABLE_MOCK_AI === 'true'
}

/**
 * Picks the provider for a user (spec §3).
 *
 * Precedence: a configured cloud key beats the trial, because the student is
 * paying for it and it's better; Ollama is reported but *not* returned as a
 * usable server-side provider, since the server cannot reach the student's
 * localhost — that path runs in their browser (spec §3.4).
 */
export async function resolveProvider(
  db: Db,
  userId: string,
): Promise<ResolvedProvider> {
  const [user] = await db
    .select({ trialPagesUsed: users.trialPagesUsed })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  const credentials = await db
    .select()
    .from(userAiCredentials)
    .where(eq(userAiCredentials.userId, userId))

  const cloud = credentials.find(
    (row) =>
      (row.provider === 'anthropic' || row.provider === 'openai') &&
      row.encryptedKey &&
      row.keyIv &&
      row.keyAuthTag,
  )

  if (cloud) {
    if (mockEnabled()) {
      return { provider: new MockProvider(), tier: 'cloud', executor: 'server' }
    }

    const apiKey = openApiKey({
      ciphertext: cloud.encryptedKey!,
      iv: cloud.keyIv!,
      authTag: cloud.keyAuthTag!,
    })

    return {
      provider:
        cloud.provider === 'anthropic'
          ? new AnthropicProvider(apiKey, cloud.visionModelName ?? undefined)
          : new OpenAIProvider(apiKey, cloud.modelName ?? undefined),
      tier: 'cloud',
      executor: 'server',
    }
  }

  const ollama = credentials.find((row) => row.provider === 'ollama' && row.ollamaBaseUrl)
  if (ollama) {
    // Reported so the UI can say "Tier C", but the work happens client-side.
    return {
      provider: new OllamaProvider({
        baseUrl: ollama.ollamaBaseUrl!,
        visionModel: ollama.visionModelName ?? 'qwen2.5vl:7b',
        textModel: ollama.modelName ?? 'qwen2.5vl:7b',
        executionSite: 'browser',
      }),
      tier: 'ollama',
      executor: 'browser',
    }
  }

  // Trial: work is done by the operator's GPU worker, not here.
  const pagesUsed = user?.trialPagesUsed ?? 0
  if (pagesUsed < 10) {
    return {
      provider: mockEnabled() ? new MockProvider() : new NullProvider(),
      tier: 'trial',
      executor: 'operator_gpu',
    }
  }

  return { provider: new NullProvider(), tier: 'free', executor: 'none' }
}

/** The provider the operator's GPU worker itself runs (spec §3.3). */
export function operatorProvider(): AIProvider {
  if (mockEnabled() && !process.env.WORKER_FORCE_REAL) {
    return new MockProvider()
  }

  return new OllamaProvider({
    baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
    visionModel: process.env.OLLAMA_VISION_MODEL ?? 'qwen2.5vl:7b',
    textModel: process.env.OLLAMA_TEXT_MODEL ?? 'qwen2.5vl:7b',
    executionSite: 'operator_gpu',
    timeoutMs: 15 * 60_000,
  })
}

export async function getCredentialSummary(db: Db, userId: string) {
  const rows = await db
    .select({
      provider: userAiCredentials.provider,
      keyLast4: userAiCredentials.keyLast4,
      ollamaBaseUrl: userAiCredentials.ollamaBaseUrl,
      modelName: userAiCredentials.modelName,
      visionModelName: userAiCredentials.visionModelName,
      verifiedAt: userAiCredentials.verifiedAt,
    })
    .from(userAiCredentials)
    .where(eq(userAiCredentials.userId, userId))

  return rows
}

export async function deleteCredential(
  db: Db,
  userId: string,
  provider: 'anthropic' | 'openai' | 'ollama',
): Promise<void> {
  await db
    .delete(userAiCredentials)
    .where(
      and(
        eq(userAiCredentials.userId, userId),
        eq(userAiCredentials.provider, provider),
      ),
    )
}
