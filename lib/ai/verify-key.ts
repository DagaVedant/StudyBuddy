import type { CloudProvider } from './providers'
import { mockEnabled } from './resolve'

const VERIFY_TIMEOUT_MS = 10_000

export type KeyVerdict =
  | { status: 'ok' }
  | { status: 'rejected'; reason: string }
  | { status: 'unreachable'; reason: string }

function probe(provider: CloudProvider, apiKey: string): [string, RequestInit] {
  switch (provider) {
    case 'anthropic':
      return [
        'https://api.anthropic.com/v1/models?limit=1',
        { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } },
      ]
    case 'openai':
      return [
        'https://api.openai.com/v1/models',
        { headers: { authorization: `Bearer ${apiKey}` } },
      ]
    case 'openrouter':
      return [
        'https://openrouter.ai/api/v1/key',
        { headers: { authorization: `Bearer ${apiKey}` } },
      ]
    case 'google':
      return [
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=1`,
        {},
      ]
  }
}

export async function verifyCloudKey(
  provider: CloudProvider,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyVerdict> {
  if (mockEnabled()) {
    return { status: 'unreachable', reason: 'mock mode is on, so nothing was checked' }
  }

  const [url, init] = probe(provider, apiKey)

  let response: Response
  try {
    response = await fetchImpl(url, {
      ...init,
      method: 'GET',
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    })
  } catch (error) {
    return {
      status: 'unreachable',
      reason: error instanceof Error ? error.message : 'the provider did not answer',
    }
  }

  if (response.ok) return { status: 'ok' }

  if (response.status === 401 || response.status === 403) {
    return {
      status: 'rejected',
      reason: `${provider} did not accept that key.`,
    }
  }

  return {
    status: 'unreachable',
    reason: `${provider} answered ${response.status}.`,
  }
}
