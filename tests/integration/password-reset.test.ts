import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  RESET_TOKEN_TTL_MS,
  consumeResetToken,
  findResetTarget,
  hashResetToken,
  issueResetToken,
} from '@/lib/auth/reset'
import type { Db } from '@/lib/db/types'
import { passwordResetTokens, users } from '@/lib/db/schema'

import { createTestDb, type TestDb } from '../helpers/db'
import { makeUser } from '../helpers/factories'

let db: TestDb
let close: () => Promise<void>

beforeAll(async () => {
  const harness = await createTestDb()
  db = harness.db
  close = harness.close
})

afterAll(async () => {
  await close()
})

describe('a password reset link', () => {
  it('is stored as a hash, never as the link that was mailed', async () => {
    const userId = await makeUser(db)
    const token = await issueResetToken(db as Db, userId)

    const [row] = await db
      .select({ tokenHash: passwordResetTokens.tokenHash })
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, userId))

    expect(row.tokenHash).not.toBe(token)
    expect(row.tokenHash).toBe(hashResetToken(token))
  })

  it('finds the account it was issued for', async () => {
    const userId = await makeUser(db)
    const token = await issueResetToken(db as Db, userId)

    expect(await findResetTarget(db as Db, token)).toMatchObject({ userId })
  })

  it('is nothing without the exact token', async () => {
    const userId = await makeUser(db)
    await issueResetToken(db as Db, userId)

    expect(await findResetTarget(db as Db, 'not-the-token')).toBeNull()
  })

  it('stops working after an hour', async () => {
    const userId = await makeUser(db)
    const token = await issueResetToken(db as Db, userId)

    const later = new Date(Date.now() + RESET_TOKEN_TTL_MS + 1000)

    expect(await findResetTarget(db as Db, token, later)).toBeNull()
  })

  it('sets the password once and cannot be spent twice', async () => {
    const userId = await makeUser(db)
    const token = await issueResetToken(db as Db, userId)

    const target = await findResetTarget(db as Db, token)
    expect(target).not.toBeNull()

    await consumeResetToken(db as Db, target!, 'hashed-by-bcrypt')

    const [user] = await db
      .select({ passwordHash: users.passwordHash, emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.id, userId))

    expect(user.passwordHash).toBe('hashed-by-bcrypt')

    // Reading the mail proves the address, which is the one thing the deleted
    // verification flow used to prove.
    expect(user.emailVerified).not.toBeNull()

    expect(await findResetTarget(db as Db, token)).toBeNull()
  })

  it('takes every other outstanding link with it', async () => {
    const userId = await makeUser(db)

    const first = await issueResetToken(db as Db, userId)
    const second = await issueResetToken(db as Db, userId)
    const third = await issueResetToken(db as Db, userId)

    const target = await findResetTarget(db as Db, second)
    await consumeResetToken(db as Db, target!, 'hashed-by-bcrypt')

    expect(await findResetTarget(db as Db, first)).toBeNull()
    expect(await findResetTarget(db as Db, third)).toBeNull()
  })

  it('belongs to one account and is not interchangeable with another', async () => {
    const mine = await makeUser(db)
    const theirs = await makeUser(db)

    const myToken = await issueResetToken(db as Db, mine)
    const theirToken = await issueResetToken(db as Db, theirs)

    expect(await findResetTarget(db as Db, myToken)).toMatchObject({ userId: mine })
    expect(await findResetTarget(db as Db, theirToken)).toMatchObject({ userId: theirs })
  })
})
