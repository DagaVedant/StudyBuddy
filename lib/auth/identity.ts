import { eq } from 'drizzle-orm'

import { users } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'
import { isUniqueViolation } from '@/lib/db/errors'

import { validateUsername } from './username'

export type SaveIdentityResult =
  | { ok: true; name: string | null; username: string | null }
  // 400: the input itself is malformed. 409: a well-formed username
  // conflicts with one already in use. Carried through rather than decided
  // by the route, so the distinction cannot drift from what actually failed.
  | { ok: false; status: 400 | 409; reason: string }

/**
 * Saves a display name and username, with the checking `PATCH
 * /api/account/identity` needs and nothing route-shaped mixed in, so it can
 * be tested directly rather than through the HTTP layer the way the route
 * itself effectively could not be without standing up a session.
 *
 * An empty username clears it rather than being rejected: every account that
 * existed before this column shipped has one that is null, and clearing back
 * to that state has to be as reachable as setting one.
 */
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
    // The check above is read-then-write, so two requests choosing the same
    // free username at once can both pass it. The unique constraint is what
    // actually decides, and this is the same "taken" message either way
    // rather than a raw constraint violation reaching the caller.
    if (isUniqueViolation(error)) {
      return { ok: false, status: 409, reason: 'That username is taken.' }
    }
    throw error
  }

  return { ok: true, name, username }
}
