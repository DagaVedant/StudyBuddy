import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Every write route used to call `await request.json()` bare. A body that is
 * not JSON makes that throw, the handler promise rejects, and Next turns the
 * rejection into a 500: the client is told the server broke when what actually
 * happened is that the client sent something unreadable. Truncated uploads on a
 * dropped mobile connection hit this, so it was not only malformed clients.
 *
 * These tests hold the handlers to resolving with a 400 instead. They call the
 * exported handler directly with a plain `Request`, which is all a route module
 * needs: the dependencies below are mocked only so far as getting past each
 * route's own gate, because the gate is not what is under test.
 */

const state = vi.hoisted(() => ({
  /** Every db call that would have written. Must stay empty on a bad body. */
  writes: [] as string[],
}))

vi.mock('@/auth', () => ({
  auth: async () => ({ user: { id: 'user-1', role: 'student' } }),
}))

vi.mock('@/lib/upload/guard', () => ({
  guardWorksheet: async () => ({ ok: true, userId: 'user-1', role: 'student' }),
}))

vi.mock('@/lib/db', () => {
  // One chainable thenable stands in for the query builder. Reads resolve to a
  // row owned by the same user the mocked session is, so ownership checks that
  // run before the body is read still pass and the body parse is reached.
  const rows = [{ userId: 'user-1', id: 'q-1' }]
  const chain: Record<string, unknown> = {
    then: (onOk: (v: unknown) => unknown, onErr: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(onOk, onErr),
  }
  for (const method of [
    'from',
    'where',
    'limit',
    'orderBy',
    'innerJoin',
    'set',
    'values',
    'returning',
    'onConflictDoUpdate',
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
      insert: record('insert'),
      update: record('update'),
      delete: record('delete'),
      // The callback is deliberately not run. Recording that the route opened a
      // transaction at all is the signal we want, and running it would bury the
      // failure in whichever statement blew up first.
      transaction: async () => {
        state.writes.push('transaction')
      },
    },
    schema: {},
  }
})

vi.mock('@/lib/rate-limit', () => ({
  UPLOAD_LIMIT: { action: 'upload', limit: 30, windowSeconds: 3600 },
  PAGE_UPLOAD_LIMIT: { action: 'page-upload', limit: 400, windowSeconds: 3600 },
  QUESTION_WRITE_LIMIT: { action: 'question-write', limit: 300, windowSeconds: 3600 },
  consumeRateLimit: async () => ({ ok: true, remaining: 29, retryAfter: 0 }),
}))

vi.mock('@/lib/storage', () => ({
  storage: { put: async () => {} },
  pageImageKey: () => 'pages/ws-1/1.png',
}))

vi.mock('@/lib/ai/resolve', () => ({
  resolveProvider: async () => ({ tier: 'trial' }),
}))

const worksheets = await import('@/app/api/worksheets/route')
const worksheetQuestions = await import('@/app/api/worksheets/[id]/questions/route')
const attempts = await import('@/app/api/worksheets/[id]/attempts/route')
const question = await import('@/app/api/questions/[questionId]/route')
const rate = await import('@/app/api/review/rate/route')
const pages = await import('@/app/api/worksheets/[id]/pages/route')

/** A body that is syntactically not JSON, announced as JSON. */
function badJson(url: string, method: 'POST' | 'PATCH' = 'POST') {
  return new Request(`http://localhost${url}`, {
    method,
    body: 'not json',
    headers: { 'content-type': 'application/json' },
  })
}

const worksheetParams = { params: Promise.resolve({ id: 'ws-1' }) }
const questionParams = { params: Promise.resolve({ questionId: 'q-1' }) }

beforeEach(() => {
  state.writes.length = 0
})

describe('a malformed JSON body answers 400 rather than throwing', () => {
  it('POST /api/worksheets', async () => {
    const response = await worksheets.POST(badJson('/api/worksheets'))

    expect(response.status).toBe(400)
    expect(state.writes).toEqual([])
  })

  it('POST /api/worksheets/[id]/questions', async () => {
    const response = await worksheetQuestions.POST(
      badJson('/api/worksheets/ws-1/questions'),
      worksheetParams,
    )

    expect(response.status).toBe(400)
    expect(state.writes).toEqual([])
  })

  it('POST /api/worksheets/[id]/attempts', async () => {
    const response = await attempts.POST(
      badJson('/api/worksheets/ws-1/attempts'),
      worksheetParams,
    )

    expect(response.status).toBe(400)
    expect(state.writes).toEqual([])
  })

  it('POST /api/review/rate', async () => {
    const response = await rate.POST(badJson('/api/review/rate'))

    expect(response.status).toBe(400)
    expect(state.writes).toEqual([])
  })

  it('PATCH /api/worksheets/[id]/pages', async () => {
    const response = await pages.PATCH(
      badJson('/api/worksheets/ws-1/pages', 'PATCH'),
      worksheetParams,
    )

    expect(response.status).toBe(400)
    expect(state.writes).toEqual([])
  })

  it('PATCH /api/questions/[questionId]', async () => {
    const response = await question.PATCH(
      badJson('/api/questions/q-1', 'PATCH'),
      questionParams,
    )

    expect(response.status).toBe(400)
    expect(state.writes).toEqual([])
  })
})

/**
 * The PATCH route parses against `questionInputSchema.partial()`, where every
 * field is optional, so `{}` is a valid body. That makes the sentinel the whole
 * fix: catching a bad body to `{}` rather than to `null` parses clean, and the
 * route answers `{ ok: true }` having written nothing the client asked for. The
 * status assertion above is what catches it, so this pins the premise, because
 * a later schema change that made any field required would silently turn that
 * test into one that passes for the wrong reason.
 */
describe('the partial() schema is why the null sentinel matters', () => {
  it('accepts {} but rejects null', async () => {
    const { questionInputSchema } = await import('@/lib/questions/shape')
    const partial = questionInputSchema.partial()

    expect(partial.safeParse({}).success).toBe(true)
    expect(partial.safeParse(null).success).toBe(false)
  })

  it('answers ok on an empty object, which is what a {} catch would produce', async () => {
    const empty = new Request('http://localhost/api/questions/q-1', {
      method: 'PATCH',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    })

    const response = await question.PATCH(empty, questionParams)

    // Not the behaviour being asked for, just the proof that a bad body must
    // never be allowed to look like this one.
    expect(response.status).toBe(200)
  })
})

/**
 * The page upload reads multipart rather than JSON. `formData()` throws on a
 * body whose boundary or Content-Type is wrong, which is a different exception
 * from the JSON one but reached Next the same way.
 */
describe('a malformed multipart body answers 400 rather than throwing', () => {
  it('POST /api/worksheets/[id]/pages', async () => {
    const request = new Request('http://localhost/api/worksheets/ws-1/pages', {
      method: 'POST',
      body: 'this is not multipart',
      headers: { 'content-type': 'multipart/form-data; boundary=----nope' },
    })

    const response = await pages.POST(request, worksheetParams)

    expect(response.status).toBe(400)
    expect(state.writes).toEqual([])
  })
})
