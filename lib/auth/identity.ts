import {createHash, randomBytes, timingSafeEqual} from 'node:crypto'

import {and, eq, gt, isNull} from 'drizzle-orm'

import {accounts, passwordResetTokens, users, worksheetPages, worksheets} from '@/lib/schema'
import {
  appBaseUrl,
  callerIp,
  consumeRateLimit,
  SIGNIN_EMAIL_LIMIT,
  SIGNIN_IP_LIMIT,
} from '@/lib/api'
import {storage} from '@/lib/queue'
import {type Db, isUniqueViolation} from '@/lib/db'

import {isAdminEmail} from './policy'

export type SaveIdentityResult =
  | {ok: true; name: string | null; username: string | null}
  | {ok: false; status: 400 | 409; reason: string}

export async function saveIdentity(
  db: Db,
  userId: string,
  input: {name: string | null; username: string | null},
): Promise<SaveIdentityResult> {
  const name = input.name?.trim() || null

  let username: string | null = null
  if (input.username && input.username.trim()) {
    const checked = validateUsername(input.username)
    if (!checked.ok) return {ok: false, status: 400, reason: checked.reason}
    username = checked.username

    const [taken] = await db
      .select({id: users.id})
      .from(users)
      .where(eq(users.username, username))
      .limit(1)

    if (taken && taken.id !== userId) {
      return {ok: false, status: 409, reason: 'That username is taken.'}
    }
  }

  try {
    await db.update(users).set({name, username}).where(eq(users.id, userId))
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {ok: false, status: 409, reason: 'That username is taken.'}
    }
    throw error
  }

  return {ok: true, name, username}
}

export const MIN_USERNAME_LENGTH = 3
export const MAX_USERNAME_LENGTH = 20

const USERNAME_SHAPE = /^[a-z][a-z0-9_]*$/

export type UsernameCheck =
  | {ok: true; username: string}
  | {ok: false; reason: string}

export function validateUsername(input: string | null | undefined): UsernameCheck {
  const trimmed = (input ?? '').trim().toLowerCase()

  if (!trimmed) return {ok: false, reason: 'Enter a username.'}

  if (trimmed.length < MIN_USERNAME_LENGTH) {
    return {ok: false, reason: `At least ${MIN_USERNAME_LENGTH} characters.`}
  }

  if (trimmed.length > MAX_USERNAME_LENGTH) {
    return {ok: false, reason: `${MAX_USERNAME_LENGTH} characters or fewer.`}
  }

  if (!USERNAME_SHAPE.test(trimmed)) {
    return {
      ok: false,
      reason: 'Letters, numbers and underscores only, starting with a letter.',
    }
  }

  return {ok: true, username: trimmed}
}

export async function accountMayBeAdmin(
  db: Db,
  userId: string,
  email: string,
): Promise<boolean> {
  if (!isAdminEmail(email)) return false

  const [link] = await db
    .select({userId: accounts.userId})
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
    .select({imageKey: worksheetPages.imageKey})
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

  return {imagesRemoved: keys.length - imagesFailed, imagesFailed}
}

export const RESET_TOKEN_TTL_MS = 60 * 60_000

const TOKEN_BYTES = 32

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function resetLink(token: string): string {
  return `${appBaseUrl()}/reset/${token}`
}

export async function issueResetToken(
  db: Db,
  userId: string,
  now: Date = new Date(),
): Promise<string> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')

  await db.insert(passwordResetTokens).values({
    userId,
    tokenHash: hashResetToken(token),
    expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MS),
  })

  return token
}

export interface ResetTarget {
  tokenId: string
  userId: string
}

export async function findResetTarget(
  db: Db,
  token: string,
  now: Date = new Date(),
): Promise<ResetTarget | null> {
  const [row] = await db
    .select({
      id: passwordResetTokens.id,
      userId: passwordResetTokens.userId,
      tokenHash: passwordResetTokens.tokenHash,
    })
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.tokenHash, hashResetToken(token)),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, now),
      ),
    )
    .limit(1)

  if (!row) return null

  const found = Buffer.from(row.tokenHash)
  const wanted = Buffer.from(hashResetToken(token))

  if (found.length !== wanted.length || !timingSafeEqual(found, wanted)) return null

  return {tokenId: row.id, userId: row.userId}
}

export async function consumeResetToken(
  db: Db,
  target: ResetTarget,
  passwordHash: string,
  now: Date = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(passwordResetTokens)
      .set({usedAt: now})
      .where(eq(passwordResetTokens.id, target.tokenId))

    await tx
      .delete(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.userId, target.userId),
          isNull(passwordResetTokens.usedAt),
        ),
      )

    await tx
      .update(users)
      .set({passwordHash, emailVerified: now})
      .where(eq(users.id, target.userId))
  })
}

export function inviteRequired(): boolean {
  return Boolean(process.env.SIGNUP_INVITE_CODE?.trim())
}

export function inviteAccepted(offered: string): boolean {
  const expected = process.env.SIGNUP_INVITE_CODE?.trim()
  if (!expected) return true

  const left = Buffer.from(offered.trim())
  const right = Buffer.from(expected)

  return left.length === right.length && timingSafeEqual(left, right)
}
