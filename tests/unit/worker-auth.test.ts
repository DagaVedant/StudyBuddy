import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { authenticateWorker } from '@/lib/worker/auth'

const TOKEN = 'worker-token-0123456789'

function request(
  headers: Record<string, string> = {},
  url = 'https://studybuddy.test/api/worker/claim',
): Request {
  return new Request(url, { headers })
}

const original = { ...process.env }

beforeEach(() => {
  process.env.WORKER_API_TOKEN = TOKEN
  
  
  
  process.env.WORKER_ALLOWED_IPS = '*'
})

afterEach(() => {
  process.env = { ...original }
})

describe('authenticateWorker', () => {
  it('accepts the configured token', () => {
    expect(authenticateWorker(request({ authorization: `Bearer ${TOKEN}` }))).toEqual({
      ok: true,
    })
  })

  it('refuses everything when no token is configured', () => {
    delete process.env.WORKER_API_TOKEN

    expect(authenticateWorker(request({ authorization: `Bearer ${TOKEN}` }))).toEqual({
      ok: false,
      status: 403,
      message: 'Worker API is not configured.',
    })
  })

  it('refuses an empty configured token', () => {
    process.env.WORKER_API_TOKEN = ''

    expect(authenticateWorker(request()).ok).toBe(false)
    expect(authenticateWorker(request({ authorization: 'Bearer ' })).ok).toBe(false)
  })

  it.each([
    ['no header at all', {}],
    ['an empty header', { authorization: '' }],
    ['the token without the scheme', { authorization: TOKEN }],
    ['the wrong scheme', { authorization: `Basic ${TOKEN}` }],
    ['a lowercase scheme', { authorization: `bearer ${TOKEN}` }],
    ['a wrong token of the same length', { authorization: 'Bearer worker-token-9876543210' }],
    ['a prefix of the token', { authorization: `Bearer ${TOKEN.slice(0, -1)}` }],
    ['the token with something appended', { authorization: `Bearer ${TOKEN}x` }],
  ])('rejects %s', (_case, headers) => {
    expect(authenticateWorker(request(headers))).toEqual({
      ok: false,
      status: 401,
      message: 'Bad worker credential.',
    })
  })

  it('accepts a token the Headers class has already trimmed', () => {
    const padded = new Request('https://studybuddy.test/api/worker/claim', {
      headers: { authorization: `Bearer ${TOKEN} ` },
    })

    expect(padded.headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
    expect(authenticateWorker(padded).ok).toBe(true)
  })

  it('does not throw on a token of a different length', () => {
    expect(() => authenticateWorker(request({ authorization: 'Bearer x' }))).not.toThrow()
    expect(() =>
      authenticateWorker(request({ authorization: `Bearer ${'x'.repeat(5000)}` })),
    ).not.toThrow()
  })

  describe('with an IP allowlist', () => {
    beforeEach(() => {
      process.env.WORKER_ALLOWED_IPS = '203.0.113.7, 198.51.100.4'
    })

    it('accepts a listed address', () => {
      expect(
        authenticateWorker(
          request({ authorization: `Bearer ${TOKEN}`, 'x-forwarded-for': '203.0.113.7' }),
        ),
      ).toEqual({ ok: true })
    })

    it('accepts the second entry, so the list is a list', () => {
      expect(
        authenticateWorker(
          request({ authorization: `Bearer ${TOKEN}`, 'x-real-ip': '198.51.100.4' }),
        ).ok,
      ).toBe(true)
    })

    it('reads the left-most forwarded entry, which is the client', () => {
      expect(
        authenticateWorker(
          request({
            authorization: `Bearer ${TOKEN}`,
            'x-forwarded-for': '203.0.113.7, 10.0.0.1, 10.0.0.2',
          }),
        ).ok,
      ).toBe(true)
    })

    it('rejects an address that is not on it', () => {
      expect(
        authenticateWorker(
          request({ authorization: `Bearer ${TOKEN}`, 'x-forwarded-for': '203.0.113.8' }),
        ),
      ).toEqual({
        ok: false,
        status: 403,
        message: 'Worker credential not valid from here.',
      })
    })

    /**
     * The case the allowlist exists for. A caller with no forwarding header is
     * one we cannot identify, and an unidentifiable caller matching an
     * allowlist entry would make the list worse than not having one.
     */
    it('rejects a caller it cannot identify', () => {
      expect(authenticateWorker(request({ authorization: `Bearer ${TOKEN}` })).ok).toBe(
        false,
      )
    })

    it('still checks the token first', () => {
      // 401 rather than 403: the credential is what failed, and reporting the
      // address instead would tell a caller with a bad token that their address
      // was fine.
      expect(
        authenticateWorker(
          request({ authorization: 'Bearer wrong', 'x-forwarded-for': '203.0.113.7' }),
        ),
      ).toEqual({ ok: false, status: 401, message: 'Bad worker credential.' })
    })

    it('ignores blank entries rather than matching on them', () => {
      process.env.WORKER_ALLOWED_IPS = ' , ,203.0.113.7, '

      expect(
        authenticateWorker(
          request({ authorization: `Bearer ${TOKEN}`, 'x-forwarded-for': '203.0.113.7' }),
        ).ok,
      ).toBe(true)
      expect(authenticateWorker(request({ authorization: `Bearer ${TOKEN}` })).ok).toBe(
        false,
      )
    })
  })

  /**
   * Finding 113. This used to read "applies no address check when the list is
   * empty", and that was the defect: the allowlist degraded to no restriction
   * exactly when nobody had configured it, which is the state every deployment
   * starts in. `.env.example` shipped it empty and the setup docs said to skip
   * it, so
   * the ordinary outcome was a defence that was never on and a leaked token
   * that worked from anywhere.
   */
  it('refuses a valid token when the allowlist was never configured', () => {
    process.env.WORKER_ALLOWED_IPS = '   '

    const result = authenticateWorker(request({ authorization: `Bearer ${TOKEN}` }))

    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ status: 403 })
  })

  it('refuses when the variable is absent entirely', () => {
    delete process.env.WORKER_ALLOWED_IPS

    expect(authenticateWorker(request({ authorization: `Bearer ${TOKEN}` })).ok).toBe(false)
  })

  /**
   * Switching the depth off is still allowed; it is now a thing somebody chose
   * and can be read out of the environment, rather than the default nobody
   * noticed.
   */
  it('allows any address when explicitly told to', () => {
    process.env.WORKER_ALLOWED_IPS = '*'

    expect(authenticateWorker(request({ authorization: `Bearer ${TOKEN}` })).ok).toBe(true)
  })

  it('still checks the token when the allowlist is open', () => {
    process.env.WORKER_ALLOWED_IPS = '*'

    expect(authenticateWorker(request({ authorization: 'Bearer wrong' })).ok).toBe(false)
  })
})
