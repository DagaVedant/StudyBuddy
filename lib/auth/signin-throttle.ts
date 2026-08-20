import type { Db } from '@/lib/db/types'
import { callerIp } from '@/lib/request'
import { SIGNIN_EMAIL_LIMIT, SIGNIN_IP_LIMIT, consumeRateLimit } from '@/lib/rate-limit'

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
