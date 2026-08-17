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

const claim = await import('@/app/api/browser-jobs/claim/route')
const explainRoute = await import('@/app/api/explain/route')
const { handleComplete } = await import('@/app/api/worker/jobs/[jobId]/handlers')
const { claimJob, enqueueJob } = await import('@/lib/queue')
const { unsolvedQuestions } = await import('@/lib/worker/solutions')
const { explainInput } = await import('@/lib/worker/explain-input')
const {
  processingJobs,
  questionSolutions,
  questions,
  userAiCredentials,
  worksheetPages,
  worksheets,
} = await import('@/lib/db/schema')
const { asDb, createTestDb } = await import('../helpers/db')
const factories = await import('../helpers/factories')

let db: Awaited<ReturnType<typeof createTestDb>>['db']
let close: () => Promise<void>

let mine: string

const client = () => asDb(db)

async function connectOllama(userId: string) {
  await db
    .insert(userAiCredentials)
    .values({
      userId,
      provider: 'ollama',
      ollamaBaseUrl: 'http://localhost:11434',
      modelName: 'qwen2.5vl:7b',
    })
    .onConflictDoNothing()
}

async function makePage(worksheetId: string) {
  const [row] = await db
    .insert(worksheetPages)
    .values({
      worksheetId,
      pageNumber: 1,
      imageKey: `pages/${worksheetId}/001.webp`,
      ocrText: '1. What is 2 + 2?',
    })
    .returning({ id: worksheetPages.id })

  return row.id
}

function claimFor(stages: string) {
  return claim.POST(
    new Request(`https://studybuddy.test/api/browser-jobs/claim?stages=${stages}`, {
      method: 'POST',
    }),
  )
}

beforeAll(async () => {
  const created = await createTestDb()
  db = created.db
  close = created.close
  state.db = asDb(db)

  mine = await factories.makeUser(db)
  await connectOllama(mine)
})

afterAll(async () => {
  await close()
})

beforeEach(() => {
  state.session = { user: { id: mine, role: 'student' } }
})

describe('unsolvedQuestions', () => {
  it('carries the choices and the page image the solver may need', async () => {
    const worksheetId = await factories.makeWorksheet(db, mine)
    const pageId = await makePage(worksheetId)

    const { id } = await factories.makeQuestion(db, mine, worksheetId, {
      promptText: 'What is 2 + 2?',
      choices: [
        { label: 'A', text: '3' },
        { label: 'B', text: '4' },
      ],
    })

    await db.update(questions).set({ pageId }).where(eq(questions.id, id))

    const pending = await unsolvedQuestions(client(), worksheetId)

    expect(pending).toHaveLength(1)
    expect(pending[0].choices.map((choice) => choice.label)).toEqual(['A', 'B'])
    expect(pending[0].pageImageKey).toBe(`pages/${worksheetId}/001.webp`)
  })

  it('leaves out anything already solved, which is what makes a restart resume', async () => {
    const worksheetId = await factories.makeWorksheet(db, mine)

    const first = await factories.makeQuestion(db, mine, worksheetId, { ordinal: 1 })
    await factories.makeQuestion(db, mine, worksheetId, { ordinal: 2 })

    await db.insert(questionSolutions).values({
      questionId: first.id,
      derivedAnswer: 'B',
      workingMd: 'because',
      confidence: 0.9,
    })

    const pending = await unsolvedQuestions(client(), worksheetId)

    expect(pending).toHaveLength(1)
    expect(pending[0].id).not.toBe(first.id)
  })
})

describe('a browser extraction that finishes', () => {
  it('queues the derived answer pass for the same browser', async () => {
    const worksheetId = await factories.makeWorksheet(db, mine)
    await db
      .update(worksheets)
      .set({ status: 'processing' })
      .where(eq(worksheets.id, worksheetId))

    const jobId = await enqueueJob(client(), {
      worksheetId,
      userId: mine,
      stage: 'extract',
      executor: 'browser',
    })

    const [job] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId))

    await handleComplete(client(), jobId, job)

    const queued = await db
      .select({ stage: processingJobs.stage, executor: processingJobs.executor })
      .from(processingJobs)
      .where(eq(processingJobs.worksheetId, worksheetId))

    expect(queued).toContainEqual({ stage: 'answer_key', executor: 'browser' })
  })
})

describe('claimJob with a stage filter', () => {
  it('hands back only the stages the caller asked for', async () => {
    const worksheetId = await factories.makeWorksheet(db, mine)
    const userId = await factories.makeUser(db)
    const theirs = await factories.makeWorksheet(db, userId)

    await enqueueJob(client(), {
      worksheetId,
      userId: mine,
      stage: 'extract',
      executor: 'browser',
    })
    await enqueueJob(client(), {
      worksheetId: theirs,
      userId,
      stage: 'answer_key',
      executor: 'browser',
    })

    const extractOnly = await claimJob(client(), 'browser', null, new Date(), mine, [
      'extract',
    ])
    expect(extractOnly?.stage).toBe('extract')

    const derivedOnly = await claimJob(client(), 'browser', null, new Date(), userId, [
      'answer_key',
      'explain',
    ])
    expect(derivedOnly?.stage).toBe('answer_key')

    expect(
      await claimJob(client(), 'browser', null, new Date(), mine, ['explain']),
    ).toBeNull()
  })
})

describe('the browser claim route', () => {
  it('hands an answer_key job the questions still to solve', async () => {
    const worksheetId = await factories.makeWorksheet(db, mine)
    await factories.makeQuestion(db, mine, worksheetId, {
      promptText: 'What is 2 + 2?',
      choices: [{ label: 'A', text: '4' }],
    })

    await enqueueJob(client(), {
      worksheetId,
      userId: mine,
      stage: 'answer_key',
      executor: 'browser',
    })

    const body = (await (await claimFor('answer_key,explain')).json()) as {
      job: { stage: string } | null
      solve?: { id: string; choices: unknown[] }[]
      pages?: unknown[]
    }

    expect(body.job?.stage).toBe('answer_key')
    expect(body.solve).toHaveLength(1)
    expect(body.pages).toBeUndefined()
  })

  it('hands an explain job the one question it names', async () => {
    const worksheetId = await factories.makeWorksheet(db, mine)
    const { id: questionId } = await factories.makeQuestion(db, mine, worksheetId, {
      promptText: 'What is the slope?',
      choices: [{ label: 'A', text: '3', isCorrect: true }],
    })

    await enqueueJob(client(), {
      worksheetId,
      userId: mine,
      stage: 'explain',
      executor: 'browser',
      checkpoint: { questionId, attemptId: null },
    })

    const body = (await (await claimFor('explain')).json()) as {
      job: { stage: string } | null
      explain?: { questionId: string; correctAnswer: string | null }
    }

    expect(body.job?.stage).toBe('explain')
    expect(body.explain?.questionId).toBe(questionId)
    expect(body.explain?.correctAnswer).toBe('A')
  })

  it('refuses an account with no Ollama connected', async () => {
    const stranger = await factories.makeUser(db)
    state.session = { user: { id: stranger, role: 'student' } }

    expect((await claimFor('answer_key')).status).toBe(409)
  })
})

describe('explainInput', () => {
  it('will not read a question belonging to somebody else', async () => {
    const other = await factories.makeUser(db)
    const worksheetId = await factories.makeWorksheet(db, other)
    const { id } = await factories.makeQuestion(db, other, worksheetId)

    expect(await explainInput(client(), mine, id)).toBeNull()
  })
})

describe('asking for an explanation on Tier C', () => {
  it('queues it for the browser rather than refusing', async () => {
    const worksheetId = await factories.makeWorksheet(db, mine)
    const { id: questionId } = await factories.makeQuestion(db, mine, worksheetId)

    const response = await explainRoute.POST(
      new Request('https://studybuddy.test/api/explain', {
        method: 'POST',
        body: JSON.stringify({ questionId }),
      }),
    )

    expect(response.status).toBe(202)

    const body = (await response.json()) as { status: string; runsHere: boolean }
    expect(body).toMatchObject({ status: 'queued', runsHere: true })

    const [job] = await db
      .select({ stage: processingJobs.stage, executor: processingJobs.executor })
      .from(processingJobs)
      .where(eq(processingJobs.id, (body as unknown as { jobId: string }).jobId))

    expect(job).toEqual({ stage: 'explain', executor: 'browser' })
  })
})
