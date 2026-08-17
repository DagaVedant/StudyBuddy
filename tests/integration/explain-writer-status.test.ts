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

const { GET, POST } = await import('@/app/api/explain/route')
const { heartbeat, markWorkerOffline } = await import('@/lib/queue')
const { gpuWorkers, processingJobs, userAiCredentials } = await import('@/lib/db/schema')
const { asDb, createTestDb } = await import('../helpers/db')
const { makeQuestion, makeUser, makeWorksheet } = await import('../helpers/factories')

let db: Awaited<ReturnType<typeof createTestDb>>['db']
let close: () => Promise<void>

let trialUser: string
let ollamaUser: string

const client = () => asDb(db)

const WORKER = 'test-gpu'

function ask(questionId: string) {
  return POST(
    new Request('https://studybuddy.test/api/explain', {
      method: 'POST',
      body: JSON.stringify({ questionId }),
    }),
  )
}

function poll(questionId: string) {
  return GET(
    new Request(
      `https://studybuddy.test/api/explain?questionId=${encodeURIComponent(questionId)}`,
    ),
  )
}

async function askableQuestion(userId: string): Promise<string> {
  const worksheetId = await makeWorksheet(db, userId)
  const { id } = await makeQuestion(db, userId, worksheetId, {
    promptText: 'What is the slope?',
    choices: [{ label: 'A', text: '3', isCorrect: true }],
  })

  return id
}

beforeAll(async () => {
  const created = await createTestDb()
  db = created.db
  close = created.close
  state.db = asDb(db)

  trialUser = await makeUser(db)
  ollamaUser = await makeUser(db)

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
  state.session = { user: { id: trialUser, role: 'student' } }
  await db.delete(gpuWorkers)
  await db.delete(processingJobs)
})

describe('a trial explanation queued while the GPU worker is off', () => {
  it('says so rather than leaving the student waiting on nothing', async () => {
    const questionId = await askableQuestion(trialUser)

    const response = await ask(questionId)
    expect(response.status).toBe(202)

    const body = (await response.json()) as { writerOnline: boolean; runsHere: boolean }
    expect(body).toMatchObject({ writerOnline: false, runsHere: false })

    const polled = (await (await poll(questionId)).json()) as {
      status: string
      writerOnline: boolean
    }
    expect(polled).toMatchObject({ status: 'queued', writerOnline: false })
  })

  it('reports the writer as up once a worker has a live heartbeat', async () => {
    const questionId = await askableQuestion(trialUser)

    await heartbeat(client(), WORKER, 'qwen2.5vl:7b')

    const body = (await (await ask(questionId)).json()) as { writerOnline: boolean }
    expect(body.writerOnline).toBe(true)

    await markWorkerOffline(client(), WORKER)

    const polled = (await (await poll(questionId)).json()) as { writerOnline: boolean }
    expect(polled.writerOnline).toBe(false)
  })

  it('never calls the writer offline when it is the student’s own browser', async () => {
    state.session = { user: { id: ollamaUser, role: 'student' } }

    const questionId = await askableQuestion(ollamaUser)

    const body = (await (await ask(questionId)).json()) as {
      runsHere: boolean
      writerOnline: boolean
      jobId: string
    }

    expect(body).toMatchObject({ runsHere: true, writerOnline: true })

    const [job] = await db
      .select({ executor: processingJobs.executor })
      .from(processingJobs)
      .where(eq(processingJobs.id, body.jobId))

    expect(job.executor).toBe('browser')
  })
})
