import { eq } from 'drizzle-orm'

import { users } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'
import { isUniqueViolation } from '@/lib/db/types'

import { validateUsername } from './username'

export type SaveIdentityResult =
  | { ok: true; name: string | null; username: string | null }
  | { ok: false; status: 400 | 409; reason: string }

export async function saveIdentity(
  db: Db,
  userId: string,
  input: { name: string | null; username: string | null },
): Promise<SaveIdentityResult> {
  const name = input.name?.trim() || null

  let username: string | null = null
  if (input.username && input.username.trim()) {
    const checked = validateUsername(input.username)
    if (!checked.ok) return { ok: false, status: 400, reason: checked.reason }
    username = checked.username

    const [taken] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username))
      .limit(1)

    if (taken && taken.id !== userId) {
      return { ok: false, status: 409, reason: 'That username is taken.' }
    }
  }

  try {
    await db.update(users).set({ name, username }).where(eq(users.id, userId))
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { ok: false, status: 409, reason: 'That username is taken.' }
    }
    throw error
  }

  return { ok: true, name, username }
}
