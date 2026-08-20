import { eq } from 'drizzle-orm'

import { type Db, isUniqueViolation } from '@/lib/db/types'
import { users } from '@/lib/db/schema'

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

export const MIN_USERNAME_LENGTH = 3
export const MAX_USERNAME_LENGTH = 20

const USERNAME_SHAPE = /^[a-z][a-z0-9_]*$/

export type UsernameCheck =
  | { ok: true; username: string }
  | { ok: false; reason: string }

export function validateUsername(input: string | null | undefined): UsernameCheck {
  const trimmed = (input ?? '').trim().toLowerCase()

  if (!trimmed) return { ok: false, reason: 'Enter a username.' }

  if (trimmed.length < MIN_USERNAME_LENGTH) {
    return { ok: false, reason: `At least ${MIN_USERNAME_LENGTH} characters.` }
  }

  if (trimmed.length > MAX_USERNAME_LENGTH) {
    return { ok: false, reason: `${MAX_USERNAME_LENGTH} characters or fewer.` }
  }

  if (!USERNAME_SHAPE.test(trimmed)) {
    return {
      ok: false,
      reason: 'Letters, numbers and underscores only, starting with a letter.',
    }
  }

  return { ok: true, username: trimmed }
}
