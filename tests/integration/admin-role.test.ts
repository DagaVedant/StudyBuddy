import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { accountMayBeAdmin } from '@/lib/auth/admin'
import { accounts, users } from '@/lib/db/schema'

import { asDb, createTestDb, type TestDb } from '../helpers/db'

let db: TestDb
let close: () => Promise<void>

beforeAll(async () => {
  const created = await createTestDb()
  db = created.db
  close = created.close

  // One address per case: the tests share a database, and the address has to
  // match the list exactly, so they cannot share one.
  process.env.ADMIN_EMAILS = [
    'boss1@studybuddy.test',
    'boss2@studybuddy.test',
    'boss3@studybuddy.test',
  ].join(',')
})

afterAll(async () => {
  await close()
})

const client = () => asDb(db)

async function makeUser(email: string, options: { google?: boolean } = {}) {
  const [row] = await db
    .insert(users)
    .values({
      email,
      // Stamped exactly as signup stamps it, which is the point: this column
      // cannot tell whether anyone owns the address.
      emailVerified: new Date(),
      passwordHash: 'not-a-real-hash',
    })
    .returning({ id: users.id })

  if (options.google) {
    await db.insert(accounts).values({
      userId: row.id,
      type: 'oauth',
      provider: 'google',
      providerAccountId: `google-${row.id}`,
    })
  }

  return row.id
}

describe('accountMayBeAdmin', () => {
  // The attack the old check allowed: register the admin address with a
  // password before its owner does, and inherit the console.
  it('refuses a password account at an admin address', async () => {
    const id = await makeUser('boss1@studybuddy.test')

    expect(await accountMayBeAdmin(client(), id, 'boss1@studybuddy.test')).toBe(false)
  })

  it('allows an admin address once Google has proved it', async () => {
    const id = await makeUser('boss2@studybuddy.test', { google: true })

    expect(await accountMayBeAdmin(client(), id, 'boss2@studybuddy.test')).toBe(true)
  })

  it('does not promote a Google account that is not on the list', async () => {
    const id = await makeUser('student@studybuddy.test', { google: true })

    expect(await accountMayBeAdmin(client(), id, 'student@studybuddy.test')).toBe(false)
  })

  // A link belonging to someone else must not carry across.
  it('reads the link on this account, not any account', async () => {
    await makeUser('other@studybuddy.test', { google: true })
    const id = await makeUser('boss3@studybuddy.test')

    expect(await accountMayBeAdmin(client(), id, 'boss3@studybuddy.test')).toBe(false)
  })
})
