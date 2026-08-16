import { and, eq } from 'drizzle-orm'

import type { Db } from '@/lib/db/types'
import { userAiCredentials, users } from '@/lib/db/schema'

import { AnthropicProvider } from './anthropic'
import { openApiKey } from './crypto'
import { GeminiProvider } from './gemini'
import { TRIAL_WORKSHEET_LIMIT } from './limits'
import { MockProvider, NullProvider } from './mock'
import { OpenAIProvider } from './openai'
import { OpenRouterProvider } from './openrouter'
import {
  CLOUD_PROVIDERS,
  DEFAULT_CLOUD_MODEL,
  isCloudProvider,
  type CloudProvider,
} from './providers'
import type { AIProvider, RawAIProvider } from './types'
import { validated } from './validated'

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

  /*
   * Ollama, which this server can never call itself.
   *
   * `isAllowedOllamaUrl` only accepts a loopback address, so the base URL
   * stored here names a machine reachable from the student's browser and
   * nowhere else (spec.md:184). The provider handed back is therefore a null
   * one: nothing on this side can run it, and saying so is the point. What
   * carries the work is `executor: 'browser'`, which tells the caller to
   * enqueue rather than execute, exactly as the trial tier does for the
   * operator's GPU. The browser then claims that job for its own user and runs
   * it against localhost.
   *
   * Ahead of the trial deliberately. A student who has installed Ollama and
   * pointed us at it has done the thing the trial exists to talk them into, and
   * silently spending a lifetime trial credit instead would be both wasteful
   * and the same lie the dashboard used to tell: settings would say Ollama and
   * the work would go somewhere else.
   */
  const ollama = credentials.find(
    (row) => row.provider === 'ollama' && row.ollamaBaseUrl,
  )

  if (ollama) {
    // Mock stands in for the student's machine the same way it stands in for a
    // cloud provider above, so the e2e suite can drive this tier without an
    // Ollama anywhere. Only under the mock flag does this run server-side.
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

/**
 * A cloud provider, already wrapped.
 *
 * Wrapping here rather than at each call site is the point: `validated` is the
 * only route from a `RawAIProvider` to an `AIProvider`, so a provider added to
 * the switch below cannot reach a caller unchecked.
 */
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
  /** "3 trial worksheets left", "Anthropic connected", "No AI configured". */
  label: string
  href: string
}

/**
 * What the dashboard's top strip shows for "Trial pages remaining (Tier 0) or
 * AI status (other tiers)" (spec.md:398).
 *
 * Read from the credentials table rather than from {@link resolveProvider}'s
 * `tier`, which answers a nearby but different question: what would run the
 * *next* upload. The two agree now that resolution has an Ollama branch, and
 * they did not before, which is what made this worth writing down: this label
 * said "Ollama connected" while resolution could not see an Ollama row at all,
 * so the dashboard reported a tier that no upload would ever use. Keeping it on
 * the credentials table means it answers what the account is set up with, which
 * is what spec.md:398 asks the strip to carry.
 */
export async function getAiStatus(db: Db, userId: string): Promise<AiStatus> {
  const credentials = await getCredentialSummary(db, userId)
  const configured = credentials.find(
    (row) => isCloudProvider(row.provider) || row.provider === 'ollama',
  )

  if (configured) {
    return {
      label: `${PROVIDER_LABEL[configured.provider as CloudProvider | 'ollama']} connected`,
      href: '/settings',
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
    }
  }

  return { label: 'No AI configured', href: '/settings' }
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
