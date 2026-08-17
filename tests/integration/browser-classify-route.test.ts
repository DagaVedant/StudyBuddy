import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  session: null as { user?: { id?: string; role?: string } } | null,
  db: null as unknown,
  executor: 'server' as 'server' | 'browser' | 'operator_gpu' | 'none',
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

vi.mock('@/lib/ai/resolve', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/resolve')>()
  const { MockProvider } = await import('@/lib/ai/mock')
  const { validated } = await import('@/lib/ai/validated')

  return {
    ...actual,
    resolveProvider: async () => ({
      provider: validated(new MockProvider()),
      tier: state.executor === 'server' ? 'cloud' : 'ollama',
      executor: state.executor,
    }),
  }
})

const { GET, POST } = await import('@/app/api/worksheets/[id]/classify/route')
const { embed } = await import('@/lib/embeddings')
const { questionTopics, questions, topics, worksheets } = await import('@/lib/db/schema')
const { asDb, createTestDb } = await import('../helpers/db')
const factories = await import('../helpers/factories')
const { makeUser, makeWorksheet, seedTaxonomy } = factories

const { and, eq, isNotNull } = await import('drizzle-orm')

let db: Awaited<ReturnType<typeof createTestDb>>['db']
let close: () => Promise<void>

let mine: string
let theirs: string

async function embedTopics(): Promise<void> {
  const leaves = await db
    .select({ id: topics.id, name: topics.name })
    .from(topics)
    .where(eq(topics.isLeaf, true))
    .limit(60)

  for (const leaf of leaves) {
    await db
      .update(topics)
      .set({ embedding: await embed(leaf.name) })
      .where(eq(topics.id, leaf.id))
  }
}

async function makeQuestion(
  worksheetId: string,
  userId: string,
  promptText: string,
  ordinal: number,
): Promise<string> {
  const { id } = await factories.makeQuestion(db, userId, worksheetId, {
    ordinal,
    promptText,
  })

  return id
}

function get(id: string) {
  return GET(new Request('https://studybuddy.test/api/x'), {
    params: Promise.resolve({ id }),
  })
}

function post(id: string, body: unknown) {
  return POST(
    new Request('https://studybuddy.test/api/x', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )
}

beforeAll(async () => {
  const created = await createTestDb()
  db = created.db
  close = created.close
  state.db = asDb(db)

  await seedTaxonomy(db)
  await embedTopics()

  mine = await makeUser(db)
  theirs = await makeUser(db)
}, 120_000)

afterAll(async () => {
  await close()
})

beforeEach(() => {
  state.session = { user: { id: mine, role: 'student' } }
  state.executor = 'server'
})

describe('the worksheet classify route', () => {
  it('refuses a signed out caller', async () => {
    state.session = null
    const worksheetId = await makeWorksheet(db, mine)

    expect((await get(worksheetId)).status).toBe(401)
    expect((await post(worksheetId, { items: [] })).status).toBe(401)
  })

  it('refuses somebody else’s worksheet', async () => {
    const worksheetId = await makeWorksheet(db, theirs)

    expect((await get(worksheetId)).status).toBe(404)
    expect((await post(worksheetId, { items: [] })).status).toBe(404)
  })

  it('lists the questions that still have no topic', async () => {
    const worksheetId = await makeWorksheet(db, mine)
    await makeQuestion(worksheetId, mine, 'What is the slope of y = 3x + 1?', 1)
    await makeQuestion(worksheetId, mine, 'Find the area of a circle of radius 4.', 2)

    const body = (await (await get(worksheetId)).json()) as {
      supported: boolean
      remaining: number
      questions: { id: string }[]
    }

    expect(body.supported).toBe(true)
    expect(body.remaining).toBe(2)
    expect(body.questions).toHaveLength(2)
  })

  it('tags a question from an embedding computed by the caller', async () => {
    const worksheetId = await makeWorksheet(db, mine)
    const questionId = await makeQuestion(
      worksheetId,
      mine,
      'What is the slope of the line y = 3x + 1?',
      1,
    )

    await db
      .update(worksheets)
      .set({ classificationError: 'not sorted yet' })
      .where(eq(worksheets.id, worksheetId))

    const response = await post(worksheetId, {
      items: [
        {
          questionId,
          embedding: await embed('What is the slope of the line y = 3x + 1?'),
        },
      ],
    })

    expect(response.status).toBe(200)

    const applied = (await response.json()) as { applied: number; done: boolean }
    expect(applied.applied).toBe(1)
    expect(applied.done).toBe(true)

    const tags = await db
      .select({ questionId: questionTopics.questionId })
      .from(questionTopics)
      .where(eq(questionTopics.questionId, questionId))

    expect(tags).toHaveLength(1)

    const [stored] = await db
      .select({ id: questions.id })
      .from(questions)
      .where(and(eq(questions.id, questionId), isNotNull(questions.embedding)))

    expect(stored).toBeDefined()

    const [worksheet] = await db
      .select({ classificationError: worksheets.classificationError })
      .from(worksheets)
      .where(eq(worksheets.id, worksheetId))

    expect(worksheet.classificationError).toBeNull()
  }, 60_000)

  it('rejects an embedding of the wrong shape without tagging anything', async () => {
    const worksheetId = await makeWorksheet(db, mine)
    const questionId = await makeQuestion(worksheetId, mine, 'Two plus two.', 1)

    const response = await post(worksheetId, {
      items: [{ questionId, embedding: [1, 2, 3] }],
    })

    expect(response.status).toBe(200)
    expect((await response.json()) as { failed: number }).toMatchObject({ failed: 1 })

    const tags = await db
      .select({ questionId: questionTopics.questionId })
      .from(questionTopics)
      .where(eq(questionTopics.questionId, questionId))

    expect(tags).toHaveLength(0)
  })

  it('will not spend a key that is not there when the pick runs in the browser', async () => {
    state.executor = 'browser'

    const worksheetId = await makeWorksheet(db, mine)
    const questionId = await makeQuestion(worksheetId, mine, 'Two plus two.', 1)

    const response = await post(worksheetId, {
      items: [{ questionId, embedding: await embed('Two plus two.') }],
    })

    expect(response.status).toBe(409)

    const listed = (await (await get(worksheetId)).json()) as {
      supported: boolean
      executor: string
    }

    expect(listed.supported).toBe(true)
    expect(listed.executor).toBe('browser')
  }, 60_000)

  it('hands the browser a shortlist and takes back the pick it made', async () => {
    state.executor = 'browser'

    const worksheetId = await makeWorksheet(db, mine)
    const questionId = await makeQuestion(
      worksheetId,
      mine,
      'What is the slope of the line y = 3x + 1?',
      1,
    )

    await db
      .update(worksheets)
      .set({ classificationError: 'not sorted yet' })
      .where(eq(worksheets.id, worksheetId))

    const shortlisted = await post(worksheetId, {
      action: 'shortlist',
      items: [
        {
          questionId,
          embedding: await embed('What is the slope of the line y = 3x + 1?'),
        },
      ],
    })

    expect(shortlisted.status).toBe(200)

    const { batch } = (await shortlisted.json()) as {
      batch: {
        questionId: string
        promptText: string
        candidates: { slug: string; name: string; path: string }[]
      }[]
    }

    expect(batch).toHaveLength(1)
    expect(batch[0].questionId).toBe(questionId)
    expect(batch[0].promptText).toContain('slope')
    expect(batch[0].candidates.length).toBeGreaterThan(0)

    const [stored] = await db
      .select({ id: questions.id })
      .from(questions)
      .where(and(eq(questions.id, questionId), isNotNull(questions.embedding)))

    expect(stored).toBeDefined()

    const applied = await post(worksheetId, {
      action: 'apply',
      results: [
        {
          questionId,
          classification: {
            topic_slug: batch[0].candidates[0].slug,
            confidence: 0.9,
            abstain: false,
            suggested_name: null,
          },
          candidates: batch[0].candidates,
        },
      ],
    })

    expect(applied.status).toBe(200)
    expect((await applied.json()) as { applied: number; done: boolean }).toMatchObject({
      applied: 1,
      done: true,
    })

    const tags = await db
      .select({ topicId: questionTopics.topicId })
      .from(questionTopics)
      .where(eq(questionTopics.questionId, questionId))

    expect(tags).toHaveLength(1)

    const [worksheet] = await db
      .select({ classificationError: worksheets.classificationError })
      .from(worksheets)
      .where(eq(worksheets.id, worksheetId))

    expect(worksheet.classificationError).toBeNull()
  }, 60_000)

  it('refuses a browser pick from an account whose key runs on the server', async () => {
    const worksheetId = await makeWorksheet(db, mine)
    const questionId = await makeQuestion(worksheetId, mine, 'Two plus two.', 1)

    const response = await post(worksheetId, {
      action: 'shortlist',
      items: [{ questionId, embedding: await embed('Two plus two.') }],
    })

    expect(response.status).toBe(409)
  }, 60_000)

  it('refuses a batch larger than the browser sends', async () => {
    const worksheetId = await makeWorksheet(db, mine)

    const items = Array.from({ length: 40 }, () => ({
      questionId: crypto.randomUUID(),
      embedding: [],
    }))

    expect((await post(worksheetId, { items })).status).toBe(400)
  })

  it('ignores a question id belonging to another worksheet', async () => {
    const worksheetId = await makeWorksheet(db, mine)
    const otherId = await makeWorksheet(db, mine)
    const questionId = await makeQuestion(otherId, mine, 'Two plus two.', 1)

    const response = await post(worksheetId, {
      items: [{ questionId, embedding: await embed('Two plus two.') }],
    })

    expect(response.status).toBe(200)
    expect((await response.json()) as { applied: number }).toMatchObject({ applied: 0 })

    const tags = await db
      .select({ questionId: questionTopics.questionId })
      .from(questionTopics)
      .where(eq(questionTopics.questionId, questionId))

    expect(tags).toHaveLength(0)
  }, 60_000)
})
