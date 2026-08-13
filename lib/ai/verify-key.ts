import type { CloudProvider } from './providers'
import { mockEnabled } from './resolve'

/**
 * Long enough for a slow provider, short enough that Settings still feels
 * like a form. This is one authenticated GET, not a generation.
 */
const VERIFY_TIMEOUT_MS = 10_000

export type KeyVerdict =
  /** The provider accepted the key. */
  | { status: 'ok' }
  /** The provider answered, and said no. The key is wrong. */
  | { status: 'rejected'; reason: string }
  /** Nobody answered. Says nothing about the key. */
  | { status: 'unreachable'; reason: string }

/** Where each provider will tell us whether a key is real, without billing. */
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

/**
 * Asks the provider whether this key works, before it is stored.
 *
 * Settings used to answer "Saved." to anything shaped like a key, and a typo
 * surfaced later as a failed job on a worksheet the student had already
 * uploaded and waited for. The provider is the only thing that knows, so it
 * gets asked.
 *
 * A models listing rather than a generation: it is authenticated, so a bad key
 * is a 401, and it costs nothing. Nobody should pay a token to find out their
 * key is valid.
 *
 * The three outcomes are kept apart on purpose. A refusal and an unreachable
 * provider look identical from the call site and mean opposite things, and
 * treating a network blip as a bad key would refuse to save a perfectly good
 * one. Only `rejected` is the key's fault.
 */
export async function verifyCloudKey(
  provider: CloudProvider,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyVerdict> {
  /*
   * Mock mode means nothing talks to a real provider, and that has to include
   * this. Otherwise the e2e suite, which saves an obviously fake key, would
   * post it to Anthropic and be told no, and a fixture would be checked
   * against somebody's live API.
   *
   * Unreachable rather than ok, because nothing checked anything. `verifiedAt`
   * stays null, which is what it means.
   */
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

  // The statuses that mean "this key is no good", as opposed to the provider
  // having a bad day. 429 is deliberately not here: a rate-limited request
  // proves the key was recognised.
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
