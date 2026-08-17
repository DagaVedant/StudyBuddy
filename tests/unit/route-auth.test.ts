import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  writes: [] as string[],
}))

vi.mock('@/auth', () => ({
  auth: async () => null,
  signOut: async () => {},
}))

vi.mock('@/lib/db', () => {
  const chain: Record<string, unknown> = {
    then: (onOk: (v: unknown) => unknown, onErr: (e: unknown) => unknown) =>
      Promise.resolve([]).then(onOk, onErr),
  }
  for (const method of [
    'from',
    'where',
    'limit',
    'offset',
    'orderBy',
    'groupBy',
    'innerJoin',
    'leftJoin',
    'set',
    'values',
    'returning',
    'onConflictDoUpdate',
    'onConflictDoNothing',
  ]) {
    chain[method] = () => chain
  }

  const record = (name: string) => () => {
    state.writes.push(name)
    return chain
  }

  return {
    db: {
      select: () => chain,
      execute: async () => [],
      insert: record('insert'),
      update: record('update'),
      delete: record('delete'),
      transaction: async () => {
        state.writes.push('transaction')
      },
    },
    schema: {},
  }
})

vi.mock('@/lib/storage', () => ({
  storage: {
    put: async () => state.writes.push('storage.put'),
    remove: async () => state.writes.push('storage.remove'),
    get: async () => null,
    getStream: async () => null,
  },
  pageImageKey: () => 'pages/ws-1/001.webp',
}))

const cronDrain = await import('@/app/api/cron/drain-server-queue/route')
const account = await import('@/app/api/account/route')
const explain = await import('@/app/api/explain/route')
const blooket = await import('@/app/api/export/blooket/route')
const blooketOne = await import('@/app/api/export/blooket/[worksheetId]/route')
const files = await import('@/app/api/files/[...key]/route')
const question = await import('@/app/api/questions/[questionId]/route')
const reports = await import('@/app/api/reports/route')
const rate = await import('@/app/api/review/rate/route')
const retire = await import('@/app/api/review/retire/route')
const credentials = await import('@/app/api/settings/credentials/route')
const adminAccount = await import('@/app/api/test/admin-account/route')
const trialUsed = await import('@/app/api/test/trial-worksheets-used/route')
const workerClaim = await import('@/app/api/worker/claim/route')
const workerClassify = await import('@/app/api/worker/classify/[worksheetId]/route')
const workerShortlist = await import(
  '@/app/api/worker/classify/[worksheetId]/shortlist/route'
)
const workerCoverage = await import('@/app/api/worker/coverage/[worksheetId]/route')
const workerExplain = await import('@/app/api/worker/explain/[jobId]/route')
const workerHeartbeat = await import('@/app/api/worker/heartbeat/route')
const workerJob = await import('@/app/api/worker/jobs/[jobId]/route')
const workerPage = await import('@/app/api/worker/pages/[pageId]/route')
const workerQuestions = await import('@/app/api/worker/questions/[worksheetId]/route')
const workerSolutions = await import('@/app/api/worker/solutions/[worksheetId]/route')
const notificationsRoute = await import('@/app/api/notifications/route')
const subscribeRoute = await import('@/app/api/notifications/subscribe/route')
const browserClaim = await import('@/app/api/browser-jobs/claim/route')
const browserJob = await import('@/app/api/browser-jobs/[jobId]/route')
const identity = await import('@/app/api/account/identity/route')
const lesson = await import('@/app/api/topics/[topicId]/lesson/route')
const practice = await import('@/app/api/topics/[topicId]/practice/route')
const goManual = await import('@/app/api/worksheets/[id]/go-manual/route')
const worksheets = await import('@/app/api/worksheets/route')
const worksheet = await import('@/app/api/worksheets/[id]/route')
const attempts = await import('@/app/api/worksheets/[id]/attempts/route')
const complete = await import('@/app/api/worksheets/[id]/complete/route')
const confirm = await import('@/app/api/worksheets/[id]/confirm/route')
const pages = await import('@/app/api/worksheets/[id]/pages/route')
const pageLines = await import('@/app/api/worksheets/[id]/pages/[pageId]/lines/route')
const questions = await import('@/app/api/worksheets/[id]/questions/route')
const verifyAll = await import('@/app/api/worksheets/[id]/check-all/route')

const UNGATED_BY_DESIGN = new Set([
  '/api/auth/[...nextauth]',
  '/api/cron/drain-server-queue',
  '/api/test/admin-account',
  '/api/test/topic-lesson',
  '/api/test/trial-worksheets-used',
])

function routePathsOnDisk(dir = 'app/api', prefix = '/api'): string[] {
  const found: string[] = []

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(...routePathsOnDisk(join(dir, entry.name), `${prefix}/${entry.name}`))
    } else if (entry.name === 'route.ts') {
      found.push(prefix)
    }
  }

  return found.sort()
}

type Handler = (request: Request, context: never) => Promise<Response>

function request(url = 'https://studybuddy.test/api/x', method = 'POST'): Request {
  return new Request(url, {
    method,
    ...(method === 'GET' || method === 'DELETE'
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  })
}

const id = (value: Record<string, string>) =>
  ({ params: Promise.resolve(value) }) as never

const WS = id({ id: 'ws-1', worksheetId: 'ws-1' })

const ROUTES: [string, Handler, string, never][] = [
  ['DELETE /api/account', account.DELETE as Handler, 'DELETE', undefined as never],
  [
    'PATCH /api/account/identity',
    identity.PATCH as Handler,
    'PATCH',
    undefined as never,
  ],
  [
    'POST /api/topics/[topicId]/lesson',
    lesson.POST as Handler,
    'POST',
    id({ topicId: 't-1' }),
  ],
  [
    'POST /api/topics/[topicId]/practice',
    practice.POST as Handler,
    'POST',
    id({ topicId: 't-1' }),
  ],
  ['POST /api/worksheets/[id]/go-manual', goManual.POST as Handler, 'POST', WS],
  ['GET /api/explain', explain.GET as Handler, 'GET', undefined as never],
  ['POST /api/explain', explain.POST as Handler, 'POST', undefined as never],
  ['GET /api/export/blooket', blooket.GET as Handler, 'GET', undefined as never],
  ['GET /api/export/blooket/[id]', blooketOne.GET as Handler, 'GET', WS],
  ['GET /api/files/[...key]', files.GET as Handler, 'GET', id({ key: 'x' })],
  [
    'PATCH /api/questions/[id]',
    question.PATCH as Handler,
    'PATCH',
    id({ questionId: 'q-1' }),
  ],
  [
    'DELETE /api/questions/[id]',
    question.DELETE as Handler,
    'DELETE',
    id({ questionId: 'q-1' }),
  ],
  ['GET /api/notifications', notificationsRoute.GET as Handler, 'GET', undefined as never],
  ['POST /api/notifications', notificationsRoute.POST as Handler, 'POST', undefined as never],
  [
    'POST /api/notifications/subscribe',
    subscribeRoute.POST as Handler,
    'POST',
    undefined as never,
  ],
  [
    'DELETE /api/notifications/subscribe',
    subscribeRoute.DELETE as Handler,
    'DELETE',
    undefined as never,
  ],
  ['POST /api/reports', reports.POST as Handler, 'POST', undefined as never],
  ['POST /api/review/rate', rate.POST as Handler, 'POST', undefined as never],
  ['POST /api/review/retire', retire.POST as Handler, 'POST', undefined as never],
  ['GET /api/settings/credentials', credentials.GET as Handler, 'GET', undefined as never],
  [
    'POST /api/settings/credentials',
    credentials.POST as Handler,
    'POST',
    undefined as never,
  ],
  [
    'DELETE /api/settings/credentials',
    credentials.DELETE as Handler,
    'DELETE',
    undefined as never,
  ],
  ['POST /api/worksheets', worksheets.POST as Handler, 'POST', undefined as never],
  ['GET /api/worksheets', worksheets.GET as Handler, 'GET', undefined as never],
  ['DELETE /api/worksheets/[id]', worksheet.DELETE as Handler, 'DELETE', WS],
  ['PATCH /api/worksheets/[id]', worksheet.PATCH as Handler, 'PATCH', WS],
  ['POST /api/worksheets/[id]/attempts', attempts.POST as Handler, 'POST', WS],
  ['PATCH /api/worksheets/[id]/attempts', attempts.PATCH as Handler, 'PATCH', WS],
  ['POST /api/browser-jobs/claim', browserClaim.POST as Handler, 'POST', undefined as never],
  [
    'POST /api/browser-jobs/[jobId]',
    browserJob.POST as Handler,
    'POST',
    id({ jobId: 'job-1' }),
  ],
  ['POST /api/worksheets/[id]/complete', complete.POST as Handler, 'POST', WS],
  ['POST /api/worksheets/[id]/confirm', confirm.POST as Handler, 'POST', WS],
  ['POST /api/worksheets/[id]/pages', pages.POST as Handler, 'POST', WS],
  ['PATCH /api/worksheets/[id]/pages', pages.PATCH as Handler, 'PATCH', WS],
  ['GET /api/worksheets/[id]/questions', questions.GET as Handler, 'GET', WS],
  ['POST /api/worksheets/[id]/questions', questions.POST as Handler, 'POST', WS],
  ['POST /api/worksheets/[id]/check-all', verifyAll.POST as Handler, 'POST', WS],
  [
    'GET /api/worksheets/[id]/pages/[pageId]/lines',
    pageLines.GET as Handler,
    'GET',
    id({ id: 'ws-1', pageId: 'p-1' }),
  ],
]

const WORKER_ROUTES: [string, Handler, string, never][] = [
  ['POST /api/worker/claim', workerClaim.POST as Handler, 'POST', undefined as never],
  ['GET /api/worker/classify/[id]', workerClassify.GET as Handler, 'GET', WS],
  ['POST /api/worker/classify/[id]', workerClassify.POST as Handler, 'POST', WS],
  [
    'POST /api/worker/classify/[id]/shortlist',
    workerShortlist.POST as Handler,
    'POST',
    WS,
  ],
  ['GET /api/worker/coverage/[id]', workerCoverage.GET as Handler, 'GET', WS],
  [
    'GET /api/worker/explain/[jobId]',
    workerExplain.GET as Handler,
    'GET',
    id({ jobId: 'j-1' }),
  ],
  [
    'POST /api/worker/heartbeat',
    workerHeartbeat.POST as Handler,
    'POST',
    undefined as never,
  ],
  ['POST /api/worker/jobs/[jobId]', workerJob.POST as Handler, 'POST', id({ jobId: 'j-1' })],
  [
    'GET /api/worker/pages/[pageId]',
    workerPage.GET as Handler,
    'GET',
    id({ pageId: 'p-1' }),
  ],
  ['GET /api/worker/questions/[id]', workerQuestions.GET as Handler, 'GET', WS],
  ['GET /api/worker/solutions/[id]', workerSolutions.GET as Handler, 'GET', WS],
]

const CRON_ROUTES: [string, Handler, string, never][] = [
  [
    'GET /api/cron/drain-server-queue',
    cronDrain.GET as Handler,
    'GET',
    undefined as never,
  ],
]

const TEST_ROUTES: [string, Handler, string, never][] = [
  [
    'POST /api/test/admin-account',
    adminAccount.POST as Handler,
    'POST',
    undefined as never,
  ],
  [
    'POST /api/test/trial-worksheets-used',
    trialUsed.POST as Handler,
    'POST',
    undefined as never,
  ],
]

const original = { ...process.env }

beforeEach(() => {
  state.writes.length = 0
})

afterEach(() => {
  process.env = { ...original }
})

describe('a caller with no session', () => {
  it.each(ROUTES)('is refused by %s', async (_name, handler, verb, context) => {
    const response = await handler(request('https://studybuddy.test/api/x', verb), context)

    expect(response.status).toBe(401)
    expect(state.writes).toEqual([])
  })

  it('is asked about by every route in the tree', () => {
    const shape = (path: string) => path.replace(/\[[^\]]+\]/g, '[]')

    const covered = new Set(
      [...ROUTES, ...WORKER_ROUTES].map(([name]) => shape(name.split(' ')[1])),
    )

    const missing = routePathsOnDisk().filter(
      (path) => !covered.has(shape(path)) && !UNGATED_BY_DESIGN.has(path),
    )

    expect(missing).toEqual([])
  })
})

describe('a caller with no worker credential', () => {
  it.each(WORKER_ROUTES)('is refused by %s', async (_name, handler, verb, context) => {
    process.env.WORKER_API_TOKEN = 'the-real-token'

    const response = await handler(request('https://studybuddy.test/api/x', verb), context)

    expect(response.status).toBe(401)
    expect(state.writes).toEqual([])
  })

  it.each(WORKER_ROUTES)(
    '%s is refused a wrong token rather than crashing on it',
    async (_name, handler, verb, context) => {
      process.env.WORKER_API_TOKEN = 'the-real-token'

      const wrong = new Request('https://studybuddy.test/api/x', {
        method: verb,
        headers: {
          authorization: 'Bearer x',
          ...(verb === 'GET' ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(verb === 'GET' ? {} : { body: '{}' }),
      })

      const response = await handler(wrong, context)

      expect(response.status).toBe(401)
      expect(state.writes).toEqual([])
    },
  )

  it.each(WORKER_ROUTES)(
    '%s refuses when no token is configured at all',
    async (_name, handler, verb, context) => {
      delete process.env.WORKER_API_TOKEN

      const response = await handler(
        request('https://studybuddy.test/api/x', verb),
        context,
      )

      expect(response.status).toBe(403)
      expect(state.writes).toEqual([])
    },
  )
})

describe('a caller with no cron credential', () => {
  it.each(CRON_ROUTES)('is refused by %s', async (_name, handler, verb, context) => {
    process.env.CRON_SECRET = 'the-real-secret'

    const response = await handler(request('https://studybuddy.test/api/x', verb), context)

    expect(response.status).toBe(401)
    expect(state.writes).toEqual([])
  })

  it.each(CRON_ROUTES)(
    '%s is refused a wrong secret rather than crashing on it',
    async (_name, handler, verb, context) => {
      process.env.CRON_SECRET = 'the-real-secret'

      const wrong = new Request('https://studybuddy.test/api/x', {
        method: verb,
        headers: { authorization: 'Bearer x' },
      })

      const response = await handler(wrong, context)

      expect(response.status).toBe(401)
      expect(state.writes).toEqual([])
    },
  )

  it.each(CRON_ROUTES)(
    '%s refuses when no secret is configured at all',
    async (_name, handler, verb, context) => {
      delete process.env.CRON_SECRET

      const response = await handler(
        request('https://studybuddy.test/api/x', verb),
        context,
      )

      expect(response.status).toBe(403)
      expect(state.writes).toEqual([])
    },
  )
})

describe('the test-only endpoints', () => {
  it.each(TEST_ROUTES)('%s is not there unless opted in', async (_name, handler, verb) => {
    delete process.env.ENABLE_TEST_ENDPOINTS

    const response = await handler(
      request('https://studybuddy.test/api/x', verb),
      undefined as never,
    )

    expect(response.status).toBe(404)
    expect(state.writes).toEqual([])
  })

  it.each(TEST_ROUTES)('%s is not opened by a truthy-ish value', async (_name, handler, verb) => {
    process.env.ENABLE_TEST_ENDPOINTS = '1'

    const response = await handler(
      request('https://studybuddy.test/api/x', verb),
      undefined as never,
    )

    expect(response.status).toBe(404)
  })
})
