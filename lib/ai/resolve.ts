import { and, eq } from 'drizzle-orm'

import type { Db } from '@/lib/db/types'
import { aiProvider, userAiCredentials, users } from '@/lib/db/schema'

import {
  AnthropicProvider,
  GeminiProvider,
  OpenAIProvider,
  OpenRouterProvider,
} from './cloud'
import { openApiKey } from './crypto'
import { TRIAL_WORKSHEET_LIMIT } from './providers'
import { MockProvider, NullProvider } from './mock'
import {
  CLOUD_PROVIDERS,
  DEFAULT_CLOUD_MODEL,
  isCloudProvider,
  type CloudProvider,
} from './providers'
import type { AIProvider, ProviderName, RawAIProvider } from './types'
import { validated } from './parse'

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
      return { provider: validated(new MockProvider()), tier: 'cloud', executor: 'server' }
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

  const ollama = credentials.find(
    (row) => row.provider === 'ollama' && row.ollamaBaseUrl,
  )

  if (ollama) {
    if (mockEnabled()) {
      return { provider: validated(new MockProvider()), tier: 'ollama', executor: 'server' }
    }

    return { provider: validated(new NullProvider()), tier: 'ollama', executor: 'browser' }
  }

  if (user?.role === 'admin') {
    return {
      provider: validated(mockEnabled() ? new MockProvider() : new NullProvider()),
      tier: 'trial',
      executor: 'operator_gpu',
    }
  }

  const worksheetsUsed = user?.trialWorksheetsUsed ?? 0
  if (worksheetsUsed < TRIAL_WORKSHEET_LIMIT) {
    return {
      provider: validated(mockEnabled() ? new MockProvider() : new NullProvider()),
      tier: 'trial',
      executor: 'operator_gpu',
    }
  }

  return { provider: validated(new NullProvider()), tier: 'free', executor: 'none' }
}

export function cloudProvider(
  provider: CloudProvider,
  apiKey: string,
  model?: string,
): AIProvider {
  return validated(rawCloudProvider(provider, apiKey, model))
}

function rawCloudProvider(
  provider: CloudProvider,
  apiKey: string,
  model?: string,
): RawAIProvider {
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

const PROVIDER_LABEL: Record<CloudProvider | 'ollama', string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  google: 'Google',
  ollama: 'Ollama',
}

export interface AiStatus {
  label: string
  href: string
  trialWorksheetsRemaining: number | null
}

export function shouldOfferAiSetup(status: AiStatus): boolean {
  return status.trialWorksheetsRemaining === 1
}

export async function getAiStatus(db: Db, userId: string): Promise<AiStatus> {
  const credentials = await getCredentialSummary(db, userId)
  const configured = credentials.find(
    (row) => isCloudProvider(row.provider) || row.provider === 'ollama',
  )

  if (configured) {
    return {
      label: `${PROVIDER_LABEL[configured.provider as CloudProvider | 'ollama']} connected`,
      href: '/settings',
      trialWorksheetsRemaining: null,
    }
  }

  const [user] = await db
    .select({ worksheetsUsed: users.trialWorksheetsUsed })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  const remaining = Math.max(0, TRIAL_WORKSHEET_LIMIT - (user?.worksheetsUsed ?? 0))

  if (remaining > 0) {
    return {
      label: `${remaining} trial worksheet${remaining === 1 ? '' : 's'} left`,
      href: '/settings',
      trialWorksheetsRemaining: remaining,
    }
  }

  return { label: 'No AI configured', href: '/settings', trialWorksheetsRemaining: 0 }
}

export function canSortTopicsHere(
  credentials: Awaited<ReturnType<typeof getCredentialSummary>>,
): boolean {
  return credentials.some(
    (row) =>
      isCloudProvider(row.provider) ||
      (row.provider === 'ollama' && Boolean(row.ollamaBaseUrl)),
  )
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

export type StoredProvider = (typeof aiProvider.enumValues)[number]

export function storedProvider(name: ProviderName): StoredProvider | null {
  return isStored(name) ? name : null
}

function isStored(name: string): name is StoredProvider {
  return (aiProvider.enumValues as readonly string[]).includes(name)
}
