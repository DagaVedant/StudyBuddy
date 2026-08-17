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

const { GET } = await import('@/app/api/worksheets/[id]/pages/[pageId]/lines/route')
const { worksheetPages } = await import('@/lib/db/schema')
const { asDb, createTestDb } = await import('../helpers/db')
const { makeUser, makeWorksheet } = await import('../helpers/factories')

let db: Awaited<ReturnType<typeof createTestDb>>['db']
let close: () => Promise<void>

let mine: string
let myWorksheet: string
let otherWorksheet: string

async function makePage(worksheetId: string, pageNumber: number, textLines: unknown) {
  const [row] = await db
    .insert(worksheetPages)
    .values({
      worksheetId,
      pageNumber,
      imageKey: `pages/${worksheetId}/${pageNumber}.webp`,
      textLines: textLines as never,
    })
    .returning({ id: worksheetPages.id })
  return row.id
}

function request(id: string, pageId: string) {
  return GET(new Request('https://studybuddy.test/api/x'), {
    params: Promise.resolve({ id, pageId }),
  })
}

beforeAll(async () => {
  const created = await createTestDb()
  db = created.db
  close = created.close
  state.db = asDb(db)

  mine = await makeUser(db)
  const someoneElse = await makeUser(db)
  myWorksheet = await makeWorksheet(db, mine)
  otherWorksheet = await makeWorksheet(db, someoneElse)
})

afterAll(async () => {
  await close()
})

describe('GET /api/worksheets/[id]/pages/[pageId]/lines', () => {
  it('returns the page\'s lines, rounded', async () => {
    state.session = { user: { id: mine, role: 'student' } }
    const pageId = await makePage(myWorksheet, 1, [
      { text: 'Angle B', bbox: [56.79999999999995, 712.3200000000002, 90.1, 725.9] },
    ])

    const response = await request(myWorksheet, pageId)
    expect(response.status).toBe(200)

    const body = (await response.json()) as { textLines: { text: string; bbox: number[] }[] }
    expect(body.textLines).toEqual([{ text: 'Angle B', bbox: [57, 712, 90, 726] }])
  })

  it('answers with an empty list rather than null for a page with no lines', async () => {
    state.session = { user: { id: mine, role: 'student' } }
    const pageId = await makePage(myWorksheet, 2, null)

    const response = await request(myWorksheet, pageId)
    const body = (await response.json()) as { textLines: unknown[] }

    expect(response.status).toBe(200)
    expect(body.textLines).toEqual([])
  })

  it('refuses a page that belongs to a different worksheet', async () => {
    state.session = { user: { id: mine, role: 'student' } }
    const pageId = await makePage(otherWorksheet, 1, [])

    const response = await request(myWorksheet, pageId)
    expect(response.status).toBe(404)
  })

  it('refuses a worksheet that is not the caller\'s', async () => {
    state.session = { user: { id: mine, role: 'student' } }
    const pageId = await makePage(otherWorksheet, 2, [])

    const response = await request(otherWorksheet, pageId)
    expect(response.status).toBe(404)
  })

  it('refuses a page id that does not exist', async () => {
    state.session = { user: { id: mine, role: 'student' } }

    const response = await request(myWorksheet, '00000000-0000-4000-8000-000000000000')
    expect(response.status).toBe(404)
  })

  it('refuses a caller with no session', async () => {
    state.session = null
    const pageId = await makePage(myWorksheet, 3, [])

    const response = await request(myWorksheet, pageId)
    expect(response.status).toBe(401)
  })
})
