import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  session: null as { user?: { id?: string; role?: string } } | null,
  db: null as unknown,
}))

vi.mock('@/auth', () => ({
  auth: async () => state.session,
}))

vi.mock('@/lib/db', () => ({
  db: new Proxy(
    {},
    {
      get(_target, property) {
        const value = (state.db as Record<string | symbol, unknown>)[property]
        return typeof value === 'function' ? value.bind(state.db) : value
      },
    },
  ),
}))

const { guardWorksheet } = await import('@/lib/upload/guard')
const { asDb, createTestDb } = await import('../helpers/db')
const { makeUser, makeWorksheet } = await import('../helpers/factories')

let db: Awaited<ReturnType<typeof createTestDb>>['db']
let close: () => Promise<void>

let mine: string
let theirs: string
let myWorksheet: string
let theirWorksheet: string

beforeAll(async () => {
  const created = await createTestDb()
  db = created.db
  close = created.close
  state.db = asDb(db)

  mine = await makeUser(db)
  theirs = await makeUser(db)
  myWorksheet = await makeWorksheet(db, mine)
  theirWorksheet = await makeWorksheet(db, theirs)
})

afterAll(async () => {
  await close()
})

describe('guardWorksheet', () => {
  it('lets an owner through, and says who they are', async () => {
    state.session = { user: { id: mine, role: 'student' } }

    expect(await guardWorksheet(myWorksheet)).toEqual({
      ok: true,
      userId: mine,
      role: 'student',
    })
  })

  it.each([
    ['no session', null],
    ['a session with no user', {}],
    ['a session whose user has no id', { user: { role: 'student' } }],
    ['an id that is the empty string', { user: { id: '', role: 'student' } }],
  ])('answers 401 for %s', async (_case, session) => {
    state.session = session

    expect(await guardWorksheet(myWorksheet)).toEqual({ ok: false, status: 401 })
  })

  it('answers 404 for somebody else\'s worksheet, exactly as for one that does not exist', async () => {
    state.session = { user: { id: mine, role: 'student' } }

    const notMine = await guardWorksheet(theirWorksheet)
    const notReal = await guardWorksheet('00000000-0000-4000-8000-000000000000')

    expect(notMine).toEqual({ ok: false, status: 404 })
    expect(notMine).toEqual(notReal)
  })

  it('does not let an admin open a worksheet that is not theirs', async () => {
    state.session = { user: { id: mine, role: 'admin' } }

    expect(await guardWorksheet(theirWorksheet)).toEqual({ ok: false, status: 404 })
  })

  it('carries the admin role through for an admin opening their own', async () => {
    state.session = { user: { id: mine, role: 'admin' } }

    expect(await guardWorksheet(myWorksheet)).toEqual({
      ok: true,
      userId: mine,
      role: 'admin',
    })
  })

  it.each([
    ['not a uuid', 'not-a-uuid'],
    ['empty', ''],
    ['a sql fragment', "' or '1'='1"],
    ['very long', 'x'.repeat(500)],
  ])('does not crash on an id that is %s', async (_case, id) => {
    state.session = { user: { id: mine, role: 'student' } }

    await expect(guardWorksheet(id)).resolves.toEqual({ ok: false, status: 404 })
  })
})
