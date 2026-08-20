import { and, eq } from 'drizzle-orm'

import { SIGNIN_EMAIL_LIMIT, SIGNIN_IP_LIMIT, consumeRateLimit } from '@/lib/rate-limit'
import { accounts } from '@/lib/db/schema'
import { callerIp } from '@/lib/request'
import { type Db } from '@/lib/db/types'

import { isAdminEmail } from './policy'

export async function accountMayBeAdmin(
  db: Db,
  userId: string,
  email: string,
): Promise<boolean> {
  if (!isAdminEmail(email)) return false

  const [link] = await db
    .select({ userId: accounts.userId })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, 'google')))
    .limit(1)

  return Boolean(link)
}

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
