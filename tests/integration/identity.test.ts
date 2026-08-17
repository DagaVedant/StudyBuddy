import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { saveIdentity } from '@/lib/auth/identity'
import { users } from '@/lib/db/schema'

import { asDb, createTestDb, type TestDb } from '../helpers/db'
import { makeUser } from '../helpers/factories'

let db: TestDb
let close: () => Promise<void>

beforeAll(async () => {
  const created = await createTestDb()
  db = created.db
  close = created.close
})

afterAll(async () => {
  await close()
})

const client = () => asDb(db)

async function usernameOf(userId: string): Promise<string | null> {
  const [row] = await db.select({ username: users.username }).from(users).where(eq(users.id, userId))
  return row?.username ?? null
}

describe('saveIdentity', () => {
  it('saves a name and username', async () => {
    const userId = await makeUser(db)

    const result = await saveIdentity(client(), userId, { name: 'Dag', username: 'DagaV' })

    expect(result).toEqual({ ok: true, name: 'Dag', username: 'dagav' })
    expect(await usernameOf(userId)).toBe('dagav')
  })

  it('clears the username when it is cleared to empty', async () => {
    const userId = await makeUser(db)
    await saveIdentity(client(), userId, { name: null, username: 'daga' })

    const result = await saveIdentity(client(), userId, { name: null, username: '' })

    expect(result).toEqual({ ok: true, name: null, username: null })
    expect(await usernameOf(userId)).toBeNull()
  })

  it('rejects a malformed username with 400, without touching the row', async () => {
    const userId = await makeUser(db)

    const result = await saveIdentity(client(), userId, { name: null, username: '1x' })

    expect(result).toMatchObject({ ok: false, status: 400 })
    expect(await usernameOf(userId)).toBeNull()
  })

  it('refuses a username another account already holds, with 409', async () => {
    const first = await makeUser(db)
    const second = await makeUser(db)
    await saveIdentity(client(), first, { name: null, username: 'taken' })

    const result = await saveIdentity(client(), second, { name: null, username: 'taken' })

    expect(result).toMatchObject({ ok: false, status: 409 })
    expect(await usernameOf(second)).toBeNull()
  })

  it('turns a database-level unique conflict into the same 409', async () => {
    const first = await makeUser(db)
    const second = await makeUser(db)

    await Promise.all([
      saveIdentity(client(), first, { name: null, username: 'racer' }),
      saveIdentity(client(), second, { name: null, username: 'racer' }),
    ])

    const results = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, 'racer'))

    expect(results).toHaveLength(1)
  })

  it('lets an account keep its own username unchanged', async () => {
    const userId = await makeUser(db)
    await saveIdentity(client(), userId, { name: null, username: 'daga' })

    const result = await saveIdentity(client(), userId, { name: 'New Name', username: 'daga' })

    expect(result).toEqual({ ok: true, name: 'New Name', username: 'daga' })
  })
})
