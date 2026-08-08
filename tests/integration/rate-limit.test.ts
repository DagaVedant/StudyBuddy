import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Db } from '@/lib/db/types'
import {
  callerIp,
  consumeRateLimit,
  limitKey,
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

  // One shared bucket is noisy for whoever lands there; no bucket at all would
  // mean stripping a header turns the limiter off.
  it('buckets together rather than opting out when there is no header', () => {
    expect(callerIp(new Headers())).toBe('unknown')
  })
})

describe('when the counter itself fails', () => {
  // This is not hypothetical. The table was missing from the deployed database
  // once, and because the check runs before anything else the endpoint does,
  // every upload returned a 500 without reaching a line of upload code.
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
