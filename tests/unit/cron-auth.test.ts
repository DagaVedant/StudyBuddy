import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { authenticateCron } from '@/lib/cron-auth'

/**
 * The credential between Vercel's own scheduler and the drain route it
 * triggers unattended (finding 7). Modeled on tests/unit/worker-auth.test.ts,
 * minus the IP allowlist: a cron dispatch comes from Vercel's own
 * infrastructure rather than one fixed machine, so there is no address to
 * check the way the GPU worker's own VPS can be.
 */

const SECRET = 'cron-secret-0123456789'

function request(
  headers: Record<string, string> = {},
  url = 'https://studybuddy.test/api/cron/drain-server-queue',
): Request {
  return new Request(url, { headers })
}

const original = { ...process.env }

beforeEach(() => {
  process.env.CRON_SECRET = SECRET
})

afterEach(() => {
  process.env = { ...original }
})

describe('authenticateCron', () => {
  it('accepts the configured secret', () => {
    expect(authenticateCron(request({ authorization: `Bearer ${SECRET}` }))).toEqual({
      ok: true,
    })
  })

  // 403 rather than 401: an unset secret is an operator mistake, not a
  // caller one, and answering 401 would invite a retry that can never work.
  it('refuses everything when no secret is configured', () => {
    delete process.env.CRON_SECRET

    expect(authenticateCron(request({ authorization: `Bearer ${SECRET}` }))).toEqual({
      ok: false,
      status: 403,
      message: 'CRON_SECRET is not configured.',
    })
  })

  it('refuses an empty configured secret', () => {
    process.env.CRON_SECRET = ''

    expect(authenticateCron(request()).ok).toBe(false)
    expect(authenticateCron(request({ authorization: 'Bearer ' })).ok).toBe(false)
  })

  it.each([
    ['no header at all', {}],
    ['an empty header', { authorization: '' }],
    ['the secret without the scheme', { authorization: SECRET }],
    ['the wrong scheme', { authorization: `Basic ${SECRET}` }],
    ['a lowercase scheme', { authorization: `bearer ${SECRET}` }],
    ['a wrong secret of the same length', { authorization: 'Bearer cron-secret-9876543210' }],
    ['a prefix of the secret', { authorization: `Bearer ${SECRET.slice(0, -1)}` }],
    ['the secret with something appended', { authorization: `Bearer ${SECRET}x` }],
  ])('rejects %s', (_case, headers) => {
    expect(authenticateCron(request(headers))).toEqual({
      ok: false,
      status: 401,
      message: 'Bad cron credential.',
    })
  })

  // timingSafeEqual throws on a length mismatch rather than returning false,
  // so the length has to be compared first. A caller sending a
  // one-character token used to be a 500, which is a crash reachable by
  // anyone who finds the path.
  it('does not throw on a secret of a different length', () => {
    expect(() => authenticateCron(request({ authorization: 'Bearer x' }))).not.toThrow()
    expect(() =>
      authenticateCron(request({ authorization: `Bearer ${'x'.repeat(5000)}` })),
    ).not.toThrow()
  })
})
