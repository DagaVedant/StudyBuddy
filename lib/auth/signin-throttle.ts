import type { Db } from '@/lib/db/types'
import { callerIp } from '@/lib/http/client-ip'
import { SIGNIN_EMAIL_LIMIT, SIGNIN_IP_LIMIT, consumeRateLimit } from '@/lib/rate-limit'

/**
 * Whether this password attempt should be refused without checking it.
 *
 * Lives here rather than inline in `authorize` so it can be tested. The e2e
 * suite runs with `DISABLE_RATE_LIMITS=true` for the whole server
 * (playwright.config.ts), because it signs up many times from one address and
 * the signup limit would throttle the tests long before it throttled anybody
 * real. That is a reasonable trade and it means no end-to-end test can observe
 * a limit working, so the coverage has to be here.
 *
 * Two keys, because they stop different things. The IP rule stops one source
 * working through a list of addresses; the email rule stops a distributed
 * attempt on one account. Either one refusing is enough.
 *
 * Call before the bcrypt compare. The compare at cost 12 is the expense being
 * defended, and charging for it after paying for it defends nothing.
 */
export async function signInThrottled(
  db: Db,
  headers: Headers,
  email: string,
): Promise<boolean> {
  const [byIp, byEmail] = await Promise.all([
    consumeRateLimit(db, SIGNIN_IP_LIMIT, `ip:${callerIp(headers)}`),
    consumeRateLimit(db, SIGNIN_EMAIL_LIMIT, `email:${email}`),
  ])

  return !byIp.ok || !byEmail.ok
}
