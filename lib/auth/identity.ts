import {createHash, randomBytes, timingSafeEqual} from 'node:crypto'

import {and, eq, gt, isNull, sql} from 'drizzle-orm'

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

const MIN_USERNAME_LENGTH = 3
const MAX_USERNAME_LENGTH = 20

const USERNAME_SHAPE = /^[a-z][a-z0-9_]*$/

export type UsernameCheck = {
  ok: boolean
  username: string | null
  reason: string
}

function validateUsername(input: string | null | undefined): UsernameCheck {
  let raw = ''
  if (input) raw = input

  const trimmed = raw.trim().toLowerCase()

  if (!trimmed) return {ok: false, username: null, reason: 'Enter a username.'}

  if (trimmed.length < MIN_USERNAME_LENGTH) {
    return {
      ok: false,
      username: null,
      reason: 'At least ' + MIN_USERNAME_LENGTH + ' characters.',
    }
  }

  if (trimmed.length > MAX_USERNAME_LENGTH) {
    return {
      ok: false,
      username: null,
      reason: MAX_USERNAME_LENGTH + ' characters or fewer.',
    }
  }

  if (!USERNAME_SHAPE.test(trimmed)) {
    return {
      ok: false,
      username: null,
      reason: 'Letters, numbers and underscores only, starting with a letter.',
    }
  }

  return {ok: true, username: trimmed, reason: ''}
}

export type SaveIdentityResult = {
  ok: boolean
  status: number
  name: string | null
  username: string | null
  reason: string
}

export async function saveIdentity(
  db: Db,
  userId: string,
  input: {name: string | null; username: string | null},
): Promise<SaveIdentityResult> {
  let name: string | null = null
  if (input.name && input.name.trim()) name = input.name.trim()

  let username: string | null = null

  if (input.username && input.username.trim()) {
    const checked = validateUsername(input.username)

    if (!checked.ok) {
      return {ok: false, status: 400, name: null, username: null, reason: checked.reason}
    }

    username = checked.username

    const [taken] = await db
      .select({id: users.id})
      .from(users)
      .where(eq(users.username, username as string))
      .limit(1)

    if (taken && taken.id !== userId) {
      return {
        ok: false,
        status: 409,
        name: null,
        username: null,
        reason: 'That username is taken.',
      }
    }
  }

  try {
    await db.update(users).set({name, username}).where(eq(users.id, userId))
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        ok: false,
        status: 409,
        name: null,
        username: null,
        reason: 'That username is taken.',
      }
    }

    throw error
  }

  return {ok: true, status: 200, name, username, reason: ''}
}

export async function emailTwinExists(db: Db, canonical: string) {
  const [twin] = await db
    .select({id: users.id})
    .from(users)
    .where(
      sql`case
        when split_part(${users.email}, '@', 2) in ('gmail.com', 'googlemail.com')
          then replace(regexp_replace(split_part(${users.email}, '@', 1), '\\+.*$', ''), '.', '') || '@gmail.com'
        else regexp_replace(split_part(${users.email}, '@', 1), '\\+.*$', '') || '@' || split_part(${users.email}, '@', 2)
      end = ${canonical}`,
    )
    .limit(1)

  if (!twin) return false

  return true
}

export async function accountMayBeAdmin(db: Db, userId: string, email: string) {
  if (!isAdminEmail(email)) return false

  const [link] = await db
    .select({userId: accounts.userId})
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, 'google')))
    .limit(1)

  if (!link) return false

  return true
}

export async function signInThrottled(db: Db, headers: Headers, email: string) {
  const [byIp, byEmail] = await Promise.all([
    consumeRateLimit(db, SIGNIN_IP_LIMIT, 'ip:' + callerIp(headers)),
    consumeRateLimit(db, SIGNIN_EMAIL_LIMIT, 'email:' + email),
  ])

  if (!byIp.ok) return true
  if (!byEmail.ok) return true

  return false
}

export type DeletedAccount = {
  imagesRemoved: number
  imagesFailed: number
}

export async function deleteAccount(db: Db, userId: string): Promise<DeletedAccount> {
  const keys = await db
    .select({imageKey: worksheetPages.imageKey})
    .from(worksheetPages)
    .innerJoin(worksheets, eq(worksheets.id, worksheetPages.worksheetId))
    .where(eq(worksheets.userId, userId))

  await db.delete(users).where(eq(users.id, userId))

  const pending = []
  for (const page of keys) pending.push(storage.remove(page.imageKey))

  const removals = await Promise.allSettled(pending)

  let imagesFailed = 0
  for (const result of removals) {
    if (result.status === 'rejected') imagesFailed = imagesFailed + 1
  }

  if (imagesFailed > 0) {
    console.error(
      '[account] deleted ' +
        userId +
        ' but ' +
        imagesFailed +
        ' of ' +
        keys.length +
        ' page image(s) could not be removed; they are orphaned in blob storage',
    )
  }

  return {imagesRemoved: keys.length - imagesFailed, imagesFailed}
}

const RESET_TOKEN_TTL_MS = 60 * 60000

const TOKEN_BYTES = 32

function hashResetToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export function resetLink(token: string) {
  return appBaseUrl() + '/reset/' + token
}

export async function issueResetToken(db: Db, userId: string) {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')

  await db.insert(passwordResetTokens).values({
    userId,
    tokenHash: hashResetToken(token),
    expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
  })

  return token
}

export type ResetTarget = {
  tokenId: string
  userId: string
}

export async function findResetTarget(
  db: Db,
  token: string,
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
        gt(passwordResetTokens.expiresAt, new Date()),
      ),
    )
    .limit(1)

  if (!row) return null

  const found = Buffer.from(row.tokenHash)
  const wanted = Buffer.from(hashResetToken(token))

  if (found.length !== wanted.length) return null
  if (!timingSafeEqual(found, wanted)) return null

  return {tokenId: row.id, userId: row.userId}
}

export async function consumeResetToken(
  db: Db,
  target: ResetTarget,
  passwordHash: string,
) {
  const now = new Date()

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

export function inviteRequired() {
  const code = process.env.SIGNUP_INVITE_CODE

  if (!code || !code.trim()) return false

  return true
}

export function inviteAccepted(offered: string) {
  const code = process.env.SIGNUP_INVITE_CODE

  if (!code || !code.trim()) return true

  const left = Buffer.from(offered.trim())
  const right = Buffer.from(code.trim())

  if (left.length !== right.length) return false

  return timingSafeEqual(left, right)
}
