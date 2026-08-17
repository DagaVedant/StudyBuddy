import { and, eq } from 'drizzle-orm'

import { accounts } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'

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
