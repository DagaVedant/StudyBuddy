import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * The only thing standing between two students' worksheets.
 *
 * Eleven routes call it and then act on the id they were given: read the pages,
 * replace the questions, post the attempts, delete the lot. It had no test.
 *
 * Run against a real database rather than a mocked query builder, because the
 * claim is about what the ownership comparison does with rows that exist, and a
 * chainable stub that resolves to whatever the test wants would assert nothing.
 */

const state = vi.hoisted(() => ({
  session: null as { user?: { id?: string; role?: string } } | null,
  db: null as unknown,
}))

vi.mock('@/auth', () => ({
  auth: async () => state.session,
}))

// The real module is a connection made at import. This forwards to the PGlite
// instance `beforeAll` creates, which cannot exist yet when this factory runs.
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

  /**
   * 404 rather than 403, and it matters. 403 says the worksheet exists and
   * belongs to somebody else, which turns the id into a probe: a signed-in
   * student could walk ids and learn which ones are real. Both cases have to
   * be indistinguishable from outside, so they are asserted together.
   */
  it('answers 404 for somebody else\'s worksheet, exactly as for one that does not exist', async () => {
    state.session = { user: { id: mine, role: 'student' } }

    const notMine = await guardWorksheet(theirWorksheet)
    const notReal = await guardWorksheet('00000000-0000-4000-8000-000000000000')

    expect(notMine).toEqual({ ok: false, status: 404 })
    expect(notMine).toEqual(notReal)
  })

  /**
   * Admin is an operations role, not a master key. The console retires topics
   * and reads reports; it was never meant to open a student's worksheet, and a
   * role check bolted on here is how that would quietly change.
   */
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

  /**
   * The id arrives from a route segment, so it is whatever was in the URL. A
   * value Postgres cannot cast to uuid makes the query throw, and an exception
   * out of a guard is a 500 on a route that should have said 404.
   */
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
