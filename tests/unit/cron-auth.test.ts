import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { authenticateCron } from '@/lib/cron-auth'

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

  it('does not throw on a secret of a different length', () => {
    expect(() => authenticateCron(request({ authorization: 'Bearer x' }))).not.toThrow()
    expect(() =>
      authenticateCron(request({ authorization: `Bearer ${'x'.repeat(5000)}` })),
    ).not.toThrow()
  })
})
