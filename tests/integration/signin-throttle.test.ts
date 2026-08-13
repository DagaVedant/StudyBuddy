import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { signInThrottled } from '@/lib/auth/signin-throttle'
import { SIGNIN_EMAIL_LIMIT, SIGNIN_IP_LIMIT } from '@/lib/rate-limit'

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

const client = () => asDb(db)

/** Headers as a request behind a proxy carries them, which is what is read. */
function from(ip: string): Headers {
  return new Headers({ 'x-forwarded-for': ip })
}

/**
 * The throttle on the door that is not the sign-in form.
 *
 * This lived in the `signIn` server action, which covers the form and nothing
 * else. Auth.js serves its own credentials callback, so
 * `POST /api/auth/callback/credentials` reached the same cost-12 bcrypt
 * compare without passing through it, and the CSRF token that route wants is
 * handed out by `GET /api/auth/csrf`.
 *
 * Tested here rather than end to end on purpose: the e2e suite sets
 * `DISABLE_RATE_LIMITS=true` for its whole server, so no limit can be observed
 * working from there.
 */
describe('signInThrottled', () => {
  it('allows a run of attempts up to the limit, then refuses', async () => {
    const ip = '198.51.100.10'
    const email = 'someone@studybuddy.test'

    for (let i = 0; i < SIGNIN_IP_LIMIT.limit; i += 1) {
      expect(await signInThrottled(client(), from(ip), email)).toBe(false)
    }

    expect(await signInThrottled(client(), from(ip), email)).toBe(true)
  })

  it('throttles the address that is guessing, not the account being guessed at', async () => {
    const email = 'target@studybuddy.test'
    const guesser = '198.51.100.20'

    for (let i = 0; i <= SIGNIN_IP_LIMIT.limit; i += 1) {
      await signInThrottled(client(), from(guesser), email)
    }
    expect(await signInThrottled(client(), from(guesser), email)).toBe(true)

    // The owner, signing in from their own address while that is happening.
    // Locking the account out would hand anybody a denial of service against
    // any address they can name.
    expect(await signInThrottled(client(), from('198.51.100.21'), email)).toBe(false)
  })

  it('stops one address working through a list of accounts', async () => {
    const ip = '198.51.100.30'

    // A different address every time, so the per-email rule never fires and
    // this is the IP rule or nothing.
    for (let i = 0; i < SIGNIN_IP_LIMIT.limit; i += 1) {
      expect(await signInThrottled(client(), from(ip), `victim-${i}@studybuddy.test`)).toBe(
        false,
      )
    }

    expect(await signInThrottled(client(), from(ip), 'victim-fresh@studybuddy.test')).toBe(
      true,
    )
  })

  it('stops a distributed attempt on one account', async () => {
    const email = 'popular@studybuddy.test'

    // A fresh address every time, so the IP rule never fires. Without the
    // per-email rule this is unthrottled by design: a botnet gets one free
    // guess per address it holds.
    for (let i = 0; i < SIGNIN_EMAIL_LIMIT.limit; i += 1) {
      expect(await signInThrottled(client(), from(`203.0.113.${i}`), email)).toBe(false)
    }

    expect(await signInThrottled(client(), from('203.0.113.200'), email)).toBe(true)
  })

  it('counts a caller with no forwarded header rather than letting it through', async () => {
    // A missing header must not amount to no limit. They share one bucket,
    // which is noisy for the rare visitor without one and is the safe side.
    for (let i = 0; i < SIGNIN_IP_LIMIT.limit; i += 1) {
      await signInThrottled(client(), new Headers(), `nobody-${i}@studybuddy.test`)
    }

    expect(await signInThrottled(client(), new Headers(), 'nobody-last@studybuddy.test')).toBe(
      true,
    )
  })
})
