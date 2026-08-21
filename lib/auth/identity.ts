import { and, eq } from 'drizzle-orm'

import { SIGNIN_EMAIL_LIMIT, SIGNIN_IP_LIMIT, consumeRateLimit } from '@/lib/rate-limit'
import { accounts, users, worksheetPages, worksheets } from '@/lib/db/schema'
import { callerIp } from '@/lib/request'
import { storage } from '@/lib/storage'
import { type Db, isUniqueViolation } from '@/lib/db/types'

import { isAdminEmail } from './policy'

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

export interface DeletedAccount {
  imagesRemoved: number
  imagesFailed: number
}

export async function deleteAccount(
  db: Db,
  userId: string,
): Promise<DeletedAccount> {
  const keys = await db
    .select({ imageKey: worksheetPages.imageKey })
    .from(worksheetPages)
    .innerJoin(worksheets, eq(worksheets.id, worksheetPages.worksheetId))
    .where(eq(worksheets.userId, userId))

  await db.delete(users).where(eq(users.id, userId))

  const removals = await Promise.allSettled(
    keys.map((page) => storage.remove(page.imageKey)),
  )

  const imagesFailed = removals.filter((result) => result.status === 'rejected').length

  if (imagesFailed > 0) {
    console.error(
      `[account] deleted ${userId} but ${imagesFailed} of ${keys.length} page image(s) ` +
        'could not be removed; they are orphaned in blob storage',
    )
  }

  return { imagesRemoved: keys.length - imagesFailed, imagesFailed }
}
