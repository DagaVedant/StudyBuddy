import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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

const { POST, PUT } = await import('@/app/api/topics/[topicId]/lesson/route')
const { topicLessons, topics, userAiCredentials } = await import('@/lib/db/schema')
const { asDb, createTestDb } = await import('../helpers/db')
const { makeUser, seedTaxonomy } = await import('../helpers/factories')

let db: Awaited<ReturnType<typeof createTestDb>>['db']
let close: () => Promise<void>

let ollamaUser: string
let plainUser: string
let topicId: string

function params(id: string) {
  return { params: Promise.resolve({ topicId: id }) }
}

function put(id: string, body: unknown) {
  return PUT(
    new Request('https://studybuddy.test/api/x', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
    params(id),
  )
}

const LESSON = {
  body_md: '# Examples\n\nDo not keep this.\n\n# Slope\n\nRise over run.',
  examples: [{ question: 'Slope of y = 2x?', working: 'Read the coefficient.', answer: '2' }],
  common_errors: [{ mistake: 'Flipping it', why: 'Run over rise', fix: 'Rise over run' }],
}

beforeAll(async () => {
  const created = await createTestDb()
  db = created.db
  close = created.close
  state.db = asDb(db)

  await seedTaxonomy(db)

  const [topic] = await db.select({ id: topics.id }).from(topics).limit(1)
  topicId = topic.id

  ollamaUser = await makeUser(db)
  plainUser = await makeUser(db)

  await db.insert(userAiCredentials).values({
    userId: ollamaUser,
    provider: 'ollama',
    ollamaBaseUrl: 'http://localhost:11434',
    modelName: 'qwen2.5vl:7b',
  })
})

afterAll(async () => {
  await close()
})

beforeEach(async () => {
  state.session = { user: { id: ollamaUser, role: 'student' } }
  await db.delete(topicLessons).where(eq(topicLessons.topicId, topicId))
})

describe('a Tier C account asking for a lesson', () => {
  it('is handed the inputs to write it locally instead of a refusal', async () => {
    const response = await POST(new Request('https://studybuddy.test/api/x'), params(topicId))

    expect(response.status).toBe(200)

    const body = (await response.json()) as {
      runsHere: boolean
      input: { topicName: string; topicPath: string }
      ollama: { baseUrl: string }
    }

    expect(body.runsHere).toBe(true)
    expect(body.input.topicName).toBeTruthy()
    expect(body.ollama.baseUrl).toBe('http://localhost:11434')
  })

  it('stores what came back, trimmed the way the server path trims it', async () => {
    const response = await put(topicId, { lesson: LESSON, model: 'qwen2.5vl:7b' })

    expect(response.status).toBe(200)

    const [row] = await db
      .select({ bodyMd: topicLessons.bodyMd, model: topicLessons.model })
      .from(topicLessons)
      .where(eq(topicLessons.topicId, topicId))

    expect(row.model).toBe('qwen2.5vl:7b')
    expect(row.bodyMd).toContain('Rise over run')
    expect(row.bodyMd).not.toContain('Do not keep this')
  })

  it('will not store a lesson that does not fit the schema', async () => {
    expect((await put(topicId, { lesson: { body_md: '' } })).status).toBe(400)

    const rows = await db
      .select({ id: topicLessons.id })
      .from(topicLessons)
      .where(eq(topicLessons.topicId, topicId))

    expect(rows).toHaveLength(0)
  })

  it('leaves an existing lesson alone rather than overwriting it', async () => {
    await put(topicId, { lesson: LESSON, model: 'first' })
    await put(topicId, {
      lesson: { ...LESSON, body_md: '# Slope\n\nSomething else.' },
      model: 'second',
    })

    const [row] = await db
      .select({ model: topicLessons.model })
      .from(topicLessons)
      .where(eq(topicLessons.topicId, topicId))

    expect(row.model).toBe('first')
  })

  it('refuses an unknown topic', async () => {
    expect((await put(crypto.randomUUID(), { lesson: LESSON })).status).toBe(404)
  })
})

describe('an account whose lessons are written on the server', () => {
  it('cannot post one in through the browser door', async () => {
    state.session = { user: { id: plainUser, role: 'student' } }

    expect((await put(topicId, { lesson: LESSON })).status).toBe(409)
  })
})
