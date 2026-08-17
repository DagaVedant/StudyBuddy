import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Db } from '@/lib/db/types'
import {
  ACCOUNT_LIMIT,
  CREDENTIAL_LIMIT,
  EXPLAIN_LIMIT,
  EXPORT_LIMIT,
  LESSON_LIMIT,
  NOTIFICATION_WRITE_LIMIT,
  PRACTICE_LIMIT,
  REVIEW_LIMIT,
  SIGNIN_EMAIL_LIMIT,
  SIGNIN_IP_LIMIT,
  SIGNUP_LIMIT,
  UPLOAD_LIMIT,
  WORKSHEET_WRITE_LIMIT,
  callerIp,
  consumeRateLimit,
  guardRateLimit,
  limitKey,
  limitedResponse,
  type LimitRule,
} from '@/lib/rate-limit'

import { asDb, createTestDb, type TestDb } from '../helpers/db'

let db: TestDb
let close: () => Promise<void>

beforeAll(async () => {
  const created = await createTestDb()
  db = created.db
  close = created.close
})

afterAll(async () => {
  await close()
})

const rule: LimitRule = { action: 'test', limit: 3, windowSeconds: 60 }
const client = () => asDb(db)

describe('consumeRateLimit', () => {
  it('allows up to the limit and then stops', async () => {
    const subject = 'ip:allow-then-stop'

    for (let n = 1; n <= 3; n += 1) {
      const decision = await consumeRateLimit(client(), rule, subject)
      expect(decision.ok).toBe(true)
      expect(decision.remaining).toBe(3 - n)
    }

    const blocked = await consumeRateLimit(client(), rule, subject)
    expect(blocked.ok).toBe(false)
    expect(blocked.remaining).toBe(0)
    expect(blocked.retryAfter).toBeGreaterThan(0)
  })

  it('keeps refusing while the window holds', async () => {
    const subject = 'ip:stays-blocked'
    for (let n = 0; n < 5; n += 1) await consumeRateLimit(client(), rule, subject)

    const again = await consumeRateLimit(client(), rule, subject)
    expect(again.ok).toBe(false)
  })

  it('starts over once the window has passed', async () => {
    const subject = 'ip:window-rolls'
    const start = new Date('2026-01-01T00:00:00Z')

    for (let n = 0; n < 4; n += 1) {
      await consumeRateLimit(client(), rule, subject, start)
    }
    expect((await consumeRateLimit(client(), rule, subject, start)).ok).toBe(false)

    const later = new Date(start.getTime() + 61_000)
    const fresh = await consumeRateLimit(client(), rule, subject, later)

    expect(fresh.ok).toBe(true)
    expect(fresh.remaining).toBe(2)
  })

  it('counts each subject separately', async () => {
    const a = 'ip:tenant-a'
    const b = 'ip:tenant-b'

    for (let n = 0; n < 4; n += 1) await consumeRateLimit(client(), rule, a)

    expect((await consumeRateLimit(client(), rule, a)).ok).toBe(false)
    expect((await consumeRateLimit(client(), rule, b)).ok).toBe(true)
  })

  it('counts each action separately for the same subject', async () => {
    const subject = 'ip:two-actions'
    const other: LimitRule = { action: 'other', limit: 3, windowSeconds: 60 }

    for (let n = 0; n < 4; n += 1) await consumeRateLimit(client(), rule, subject)

    expect((await consumeRateLimit(client(), rule, subject)).ok).toBe(false)
    expect((await consumeRateLimit(client(), other, subject)).ok).toBe(true)
  })

  it('does not let concurrent requests both slip past the limit', async () => {
    const subject = 'ip:concurrent'

    const decisions = await Promise.all(
      Array.from({ length: 10 }, () => consumeRateLimit(client(), rule, subject)),
    )

    expect(decisions.filter((d) => d.ok)).toHaveLength(3)
  })
})

describe('limitKey', () => {
  it('namespaces by action so two limits cannot collide', () => {
    expect(limitKey({ action: 'signup', limit: 1, windowSeconds: 1 }, 'ip:1.2.3.4')).toBe(
      'signup:ip:1.2.3.4',
    )
  })

  it('caps the subject so a long header cannot overflow the key', () => {
    const key = limitKey(rule, 'x'.repeat(500))
    expect(key.length).toBeLessThanOrEqual(190)
  })
})

describe('callerIp', () => {
  it('takes the client from the left of x-forwarded-for', () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.4, 70.41.3.18' })
    expect(callerIp(headers)).toBe('203.0.113.4')
  })

  it('falls back to x-real-ip', () => {
    expect(callerIp(new Headers({ 'x-real-ip': '198.51.100.7' }))).toBe('198.51.100.7')
  })

  it('buckets together rather than opting out when there is no header', () => {
    expect(callerIp(new Headers())).toBe('unknown')
  })
})

describe('when the counter itself fails', () => {
  const broken = {
    execute: () => Promise.reject(new Error('relation "rate_limits" does not exist')),
  } as unknown as Db

  it('lets the request through rather than taking the endpoint down', async () => {
    const decision = await consumeRateLimit(broken, rule, 'ip:db-is-down')

    expect(decision.ok).toBe(true)
    expect(decision.retryAfter).toBe(0)
  })

  it('still allows when the statement returns nothing', async () => {
    const empty = { execute: () => Promise.resolve([]) } as unknown as Db

    expect((await consumeRateLimit(empty, rule, 'ip:no-rows')).ok).toBe(true)
  })
})

describe('the sign-in limits', () => {
  it('throttles one address being guessed at from many machines', async () => {
    const email = 'email:victim@example.com'

    for (let n = 0; n < SIGNIN_EMAIL_LIMIT.limit; n += 1) {
      const perIp = await consumeRateLimit(client(), SIGNIN_IP_LIMIT, `ip:10.0.0.${n}`)
      expect(perIp.ok, `ip attempt ${n}`).toBe(true)

      const perEmail = await consumeRateLimit(client(), SIGNIN_EMAIL_LIMIT, email)
      expect(perEmail.ok, `email attempt ${n}`).toBe(true)
    }

    expect((await consumeRateLimit(client(), SIGNIN_EMAIL_LIMIT, email)).ok).toBe(false)
  })

  it('throttles one machine working through many addresses', async () => {
    const ip = 'ip:198.51.100.7'

    for (let n = 0; n < SIGNIN_IP_LIMIT.limit; n += 1) {
      const decision = await consumeRateLimit(client(), SIGNIN_IP_LIMIT, ip)
      expect(decision.ok, `attempt ${n}`).toBe(true)
    }

    expect((await consumeRateLimit(client(), SIGNIN_IP_LIMIT, ip)).ok).toBe(false)
  })

  it('is harder to lock a stranger out than to be stopped guessing', () => {
    expect(SIGNIN_EMAIL_LIMIT.limit).toBeGreaterThan(SIGNIN_IP_LIMIT.limit)
  })

  it('keeps the two rules in separate buckets', () => {
    expect(limitKey(SIGNIN_IP_LIMIT, 'x')).not.toBe(limitKey(SIGNIN_EMAIL_LIMIT, 'x'))
  })
})

const SESSION_RULES: [string, LimitRule][] = [
  ['lesson', LESSON_LIMIT],
  ['practice', PRACTICE_LIMIT],
  ['account', ACCOUNT_LIMIT],
  ['credential', CREDENTIAL_LIMIT],
  ['export', EXPORT_LIMIT],
  ['review', REVIEW_LIMIT],
  ['worksheet-write', WORKSHEET_WRITE_LIMIT],
  ['notification-write', NOTIFICATION_WRITE_LIMIT],
]

describe('the session-authenticated rules', () => {
  it('all sit in their own bucket', () => {
    const keys = SESSION_RULES.map(([, rule]) => limitKey(rule, 'user:u-1'))

    expect(new Set(keys).size).toBe(SESSION_RULES.length)
  })

  it.each(SESSION_RULES)('%s stops a caller past its limit', async (name, rule) => {
    const subject = `user:past-${name}`

    for (let n = 0; n < rule.limit; n += 1) {
      const decision = await consumeRateLimit(client(), rule, subject)
      expect(decision.ok, `attempt ${n}`).toBe(true)
    }

    expect((await consumeRateLimit(client(), rule, subject)).ok).toBe(false)
  })

  it.each(SESSION_RULES)('%s lets a caller through when the counter breaks', async (_name, rule) => {
    const broken = {
      execute: async () => {
        throw new Error('relation "rate_limits" does not exist')
      },
    } as unknown as Db

    expect((await consumeRateLimit(broken, rule, 'user:u-1')).ok).toBe(true)
  })

  it('caps generation to a day rather than an hour', () => {
    expect(PRACTICE_LIMIT.windowSeconds).toBe(86_400)
  })

  it('leaves room for a long review session before it bites', () => {
    expect(REVIEW_LIMIT.limit).toBeGreaterThan(UPLOAD_LIMIT.limit)
  })
})

describe('guardRateLimit', () => {
  it('returns nothing while the caller is inside the limit', async () => {
    expect(await guardRateLimit(client(), PRACTICE_LIMIT, 'user:guard-ok', 'no')).toBe(null)
  })

  it('answers 429 with a Retry-After once the limit is spent', async () => {
    const subject = 'user:guard-spent'

    for (let n = 0; n < ACCOUNT_LIMIT.limit; n += 1) {
      await consumeRateLimit(client(), ACCOUNT_LIMIT, subject)
    }

    const response = await guardRateLimit(
      client(),
      ACCOUNT_LIMIT,
      subject,
      'Slow down.',
    )

    expect(response?.status).toBe(429)
    expect(Number(response?.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(await response?.json()).toEqual({ error: 'Slow down.' })
  })

  it('carries the message the route chose', async () => {
    const response = limitedResponse(
      { ok: false, remaining: 0, retryAfter: 42, reason: 'limited' },
      'Try tomorrow.',
    )

    expect(response.headers.get('Retry-After')).toBe('42')
    expect(await response.json()).toEqual({ error: 'Try tomorrow.' })
  })
})

describe('which side a rule fails on', () => {
  const broken = {
    execute: async () => {
      throw new Error('relation "rate_limits" does not exist')
    },
  } as unknown as Db

  const silent = { execute: async () => [] } as unknown as Db

  it('refuses a signup it cannot count', async () => {
    const decision = await consumeRateLimit(broken, SIGNUP_LIMIT, 'ip:203.0.113.4')

    expect(decision.ok).toBe(false)
    expect(decision.reason).toBe('unavailable')
  })

  it('refuses a signup when the counter comes back empty', async () => {
    const decision = await consumeRateLimit(silent, SIGNUP_LIMIT, 'ip:203.0.113.4')

    expect(decision.ok).toBe(false)
    expect(decision.reason).toBe('unavailable')
  })

  it('asks for a short wait rather than the whole window', async () => {
    const decision = await consumeRateLimit(broken, SIGNUP_LIMIT, 'ip:203.0.113.4')

    expect(decision.retryAfter).toBeLessThanOrEqual(60)
  })

  it.each([
    ['sign-in', SIGNIN_IP_LIMIT],
    ['upload', UPLOAD_LIMIT],
    ['explain', EXPLAIN_LIMIT],
  ])('still lets %s through when the counter is broken', async (_name, rule) => {
    expect((await consumeRateLimit(broken, rule, 'subject')).ok).toBe(true)
  })
})
