import { and, eq } from 'drizzle-orm'

import type { Db } from '@/lib/dashboard/queries'
import { userAiCredentials, users } from '@/lib/db/schema'

import { AnthropicProvider } from './anthropic'
import { openApiKey } from './crypto'
import { GeminiProvider } from './gemini'
import { TRIAL_WORKSHEET_LIMIT } from './limits'
import { MockProvider, NullProvider } from './mock'
import { OllamaProvider } from './ollama'
import { OpenAIProvider } from './openai'
import { OpenRouterProvider } from './openrouter'
import {
  CLOUD_PROVIDERS,
  DEFAULT_CLOUD_MODEL,
  isCloudProvider,
  type CloudProvider,
} from './providers'
import type { AIProvider } from './types'

export { CLOUD_PROVIDERS, DEFAULT_CLOUD_MODEL, type CloudProvider }

export type Tier = 'trial' | 'free' | 'cloud' | 'ollama'

export interface ResolvedProvider {
  provider: AIProvider
  tier: Tier

  executor: 'server' | 'browser' | 'operator_gpu' | 'none'
}

export function mockEnabled(): boolean {
  return process.env.ENABLE_MOCK_AI === 'true'
}

export async function resolveProvider(
  db: Db,
  userId: string,
): Promise<ResolvedProvider> {
  const [user] = await db
    .select({ trialWorksheetsUsed: users.trialWorksheetsUsed, role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  const credentials = await db
    .select()
    .from(userAiCredentials)
    .where(eq(userAiCredentials.userId, userId))

  const cloud = credentials.find(
    (row) =>
      isCloudProvider(row.provider) && row.encryptedKey && row.keyIv && row.keyAuthTag,
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
      provider: cloudProvider(
        cloud.provider as CloudProvider,
        apiKey,
        cloud.visionModelName ?? cloud.modelName ?? undefined,
      ),
      tier: 'cloud',
      executor: 'server',
    }
  }

  if (user?.role === 'admin') {
    return {
      provider: mockEnabled() ? new MockProvider() : new NullProvider(),
      tier: 'trial',
      executor: 'operator_gpu',
    }
  }

  const worksheetsUsed = user?.trialWorksheetsUsed ?? 0
  if (worksheetsUsed < TRIAL_WORKSHEET_LIMIT) {
    return {
      provider: mockEnabled() ? new MockProvider() : new NullProvider(),
      tier: 'trial',
      executor: 'operator_gpu',
    }
  }

  return { provider: new NullProvider(), tier: 'free', executor: 'none' }
}

export function cloudProvider(
  provider: CloudProvider,
  apiKey: string,
  model?: string,
): AIProvider {
  const chosen = model || DEFAULT_CLOUD_MODEL[provider]

  switch (provider) {
    case 'anthropic':
      return new AnthropicProvider(apiKey, chosen)
    case 'openai':
      return new OpenAIProvider(apiKey, chosen)
    case 'openrouter':
      return new OpenRouterProvider(apiKey, chosen)
    case 'google':
      return new GeminiProvider(apiKey, chosen)
  }
}

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
  provider: CloudProvider | 'ollama',
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
