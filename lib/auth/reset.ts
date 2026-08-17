import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import { and, eq, gt, isNull } from 'drizzle-orm'

import { appBaseUrl } from '@/lib/app-url'
import { passwordResetTokens, users } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'

export const RESET_TOKEN_TTL_MS = 60 * 60_000

const TOKEN_BYTES = 32

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function resetLink(token: string): string {
  return `${appBaseUrl()}/reset/${token}`
}

/**
 * Only the hash is stored. A leaked database row is then no more use than a
 * leaked password hash: it cannot be replayed as the link that was mailed.
 */
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

  // The lookup above already matched on the hash, so this only guards against
  // a comparison that leaks timing somewhere below the query. Cheap, and the
  // shape is the one to copy if the lookup ever stops being an equality.
  const found = Buffer.from(row.tokenHash)
  const wanted = Buffer.from(hashResetToken(token))

  if (found.length !== wanted.length || !timingSafeEqual(found, wanted)) return null

  return { tokenId: row.id, userId: row.userId }
}

/**
 * Spends the token and sets the password in one go. Every other outstanding
 * token for that account goes too: a student who asked three times, then read
 * the first mail, should not leave two live links behind in their inbox.
 */
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
