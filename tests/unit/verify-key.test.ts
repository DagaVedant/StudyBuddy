import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { verifyCloudKey } from '@/lib/ai/verify-key'

/**
 * Asking the provider, and telling a refusal apart from a bad day.
 *
 * The distinction is the whole point. A refusal and an unreachable provider
 * look identical from the call site and mean opposite things: one is the
 * student's typo, the other is the network, and treating the second as the
 * first refuses to save a perfectly good key.
 */
describe('verifyCloudKey', () => {
  const ok = () => Promise.resolve(new Response('{}', { status: 200 }))

  // Mock mode short-circuits this, and it is on by default under the e2e
  // server rather than here. Cleared so these test the real path.
  const wasMock = process.env.ENABLE_MOCK_AI
  beforeEach(() => {
    delete process.env.ENABLE_MOCK_AI
  })
  afterEach(() => {
    if (wasMock !== undefined) process.env.ENABLE_MOCK_AI = wasMock
  })

  it('checks nothing when mock mode is on, and does not claim it did', async () => {
    process.env.ENABLE_MOCK_AI = 'true'
    const verdict = await verifyCloudKey('anthropic', 'anything', () => {
      throw new Error('must not reach a provider in mock mode')
    })
    expect(verdict.status).toBe('unreachable')
  })

  it('accepts a key the provider recognises', async () => {
    expect(await verifyCloudKey('anthropic', 'sk-ant-real', ok)).toEqual({ status: 'ok' })
  })

  it('sends the credential the way each provider wants it', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const record: typeof fetch = (url, init) => {
      seen.push({ url: String(url), init: init ?? {} })
      return ok()
    }

    await verifyCloudKey('anthropic', 'KEY', record)
    await verifyCloudKey('openai', 'KEY', record)
    await verifyCloudKey('google', 'KEY', record)

    const headersOf = (i: number) => new Headers(seen[i].init.headers)
    expect(headersOf(0).get('x-api-key')).toBe('KEY')
    expect(headersOf(1).get('authorization')).toBe('Bearer KEY')
    // Google takes it in the query string, so it must be escaped rather than
    // concatenated.
    expect(seen[2].url).toContain('key=KEY')
  })

  it('rejects a key the provider refuses', async () => {
    for (const status of [401, 403]) {
      const verdict = await verifyCloudKey('openai', 'sk-typo', () =>
        Promise.resolve(new Response('no', { status })),
      )
      expect(verdict.status, `${status}`).toBe('rejected')
    }
  })

  /*
   * A rate-limited request proves the key was recognised, so it is not the
   * key's fault and must not block the save.
   */
  it('does not call a rate limit a bad key', async () => {
    const verdict = await verifyCloudKey('openai', 'sk-real', () =>
      Promise.resolve(new Response('slow down', { status: 429 })),
    )
    expect(verdict.status).toBe('unreachable')
  })

  it('treats an outage as unknown rather than as a refusal', async () => {
    const down = await verifyCloudKey('google', 'KEY', () =>
      Promise.resolve(new Response('bad gateway', { status: 502 })),
    )
    expect(down.status).toBe('unreachable')

    const offline = await verifyCloudKey('google', 'KEY', () =>
      Promise.reject(new Error('getaddrinfo ENOTFOUND')),
    )
    expect(offline.status).toBe('unreachable')
  })
})
