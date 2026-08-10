import { and, eq } from 'drizzle-orm'

import { accounts } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'

import { isAdminEmail } from './policy'

/**
 * Whether this account is allowed to hold the admin role.
 *
 * Two conditions, and the second is the one that took a while to get right.
 * The address has to be in `ADMIN_EMAILS`, and the account has to have proved
 * it owns that address, which on this app only a linked Google account does.
 *
 * It used to ask for `emailVerified` instead, with a comment explaining that an
 * unverified account at an admin address must not inherit the role. The
 * instinct was right and the check was empty: password signup stamps
 * `emailVerified` at creation, by its own admission without proof of
 * ownership, so it was true for every credentials account and the rule reduced
 * to "is this address in the list".
 *
 * What that allowed was not escalation but arriving first. The example admin
 * addresses ship in `.env.example`, so whoever registered one held the console,
 * and the rightful holder could not take it back: signup refuses an address
 * that already exists, and Google will not link into an account it did not
 * create. Signup now refuses admin addresses outright for the same reason.
 *
 * Kept out of `auth.ts` so it can be tested without standing up NextAuth.
 */
export async function accountMayBeAdmin(
  db: Db,
  userId: string,
  email: string,
): Promise<boolean> {
  // Cheap first: most accounts are not admin addresses and need no query.
  if (!isAdminEmail(email)) return false

  const [link] = await db
    .select({ userId: accounts.userId })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, 'google')))
    .limit(1)

  return Boolean(link)
}
