import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import { and, eq, gt, isNull } from 'drizzle-orm'

import { appBaseUrl } from '@/lib/request'
import { passwordResetTokens, users } from '@/lib/db/schema'
import { type Db } from '@/lib/db/types'

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

  return { tokenId: row.id, userId: row.userId }
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
      .set({ usedAt: now })
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
      .set({ passwordHash, emailVerified: now })
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
