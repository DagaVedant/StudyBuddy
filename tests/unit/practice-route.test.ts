import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Tier } from '@/lib/ai/resolve'
import type { ExecutionSite } from '@/lib/ai/types'

const state = vi.hoisted(() => ({
  tier: 'cloud' as Tier,
  executor: 'server' as 'server' | 'browser' | 'operator_gpu' | 'none',
  executionSite: 'server' as ExecutionSite,
  limited: false,
  generated: 0,
  ollama: true,
  calls: [] as string[],
}))

vi.mock('@/auth', () => ({
  auth: async () => ({ user: { id: 'user-1', role: 'student' } }),
}))

vi.mock('@/lib/db', () => {
  const chain: Record<string, unknown> = {
    then: (onOk: (v: unknown) => unknown) => Promise.resolve([{ id: 'topic-1' }]).then(onOk),
  }
  for (const method of ['from', 'where', 'limit']) chain[method] = () => chain

  return { db: { select: () => chain }, schema: {} }
})

vi.mock('@/lib/ai/resolve', () => ({
  resolveProvider: async () => ({
    provider: { executionSite: state.executionSite, name: 'mock' },
    tier: state.tier,
    executor: state.executor,
  }),
}))

vi.mock('@/lib/rate-limit', () => ({
  PRACTICE_LIMIT: { action: 'practice', limit: 12, windowSeconds: 86_400 },
  guardRateLimit: async () => {
    state.calls.push('rate-limit')
    return state.limited ? Response.json({ error: 'slow down' }, { status: 429 }) : null
  },
}))

vi.mock('@/lib/ai/ollama-config', () => ({
  ollamaConfig: async () =>
    state.ollama ? { baseUrl: 'http://localhost:11434', textModel: 'qwen', visionModel: 'qwen' } : null,
}))

vi.mock('@/lib/practice/generate', () => ({
  PRACTICE_BATCH: 4,
  PRACTICE_BATCH_MAX: 8,
  generatePractice: async () => {
    state.calls.push('generate')
    return {
      created: state.generated,
      rejected: state.generated === 0 ? [{ flags: [] }] : [],
      questionIds: [],
    }
  },
  practiceInput: async () => {
    state.calls.push('input')
    return { topicName: 'Triangles', topicPath: 'Math > Triangles', owned: [], count: 4 }
  },
  acceptPractice: async () => {
    state.calls.push('accept')
    return {
      created: state.generated,
      rejected: state.generated === 0 ? [{ flags: [] }] : [],
      questionIds: [],
    }
  },
}))

const practice = await import('@/app/api/topics/[topicId]/practice/route')

const params = { params: Promise.resolve({ topicId: 'topic-1' }) } as never

function post(body: unknown = {}) {
  return new Request('https://studybuddy.test/api/topics/topic-1/practice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  state.tier = 'cloud'
  state.executor = 'server'
  state.executionSite = 'server'
  state.limited = false
  state.generated = 4
  state.ollama = true
  state.calls.length = 0
})

describe('which tiers may write practice questions', () => {
  it('lets a cloud key through', async () => {
    const response = await practice.POST(post(), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ created: 4 })
  })

  it('turns the free tier away, having called no model', async () => {
    state.tier = 'free'
    state.executor = 'none'
    state.executionSite = 'none'

    const response = await practice.POST(post(), params)

    expect(response.status).toBe(409)
    expect(state.calls).toEqual([])
  })

  it('turns the trial away rather than queueing work the worker cannot do', async () => {
    state.tier = 'trial'
    state.executor = 'operator_gpu'
    state.executionSite = 'none'

    const response = await practice.POST(post(), params)

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('Settings'),
    })
    expect(state.calls).toEqual([])
  })

  it('hands an Ollama student the batch to write on their own machine', async () => {
    state.tier = 'ollama'
    state.executor = 'browser'
    state.executionSite = 'none'

    const response = await practice.POST(post(), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      runsHere: true,
      input: { count: 4 },
      ollama: { baseUrl: 'http://localhost:11434' },
    })

    // No model call here: the batch is written in the browser.
    expect(state.calls).toEqual(['rate-limit', 'input'])
  })

  it('turns an Ollama student away when the address is gone from settings', async () => {
    state.tier = 'ollama'
    state.executor = 'browser'
    state.executionSite = 'none'
    state.ollama = false

    const response = await practice.POST(post(), params)

    expect(response.status).toBe(409)
  })
})

describe('the batch a browser writes on its own GPU', () => {
  function put(body: unknown) {
    return new Request('https://studybuddy.test/api/topics/topic-1/practice', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  const written = {
    questions: [
      {
        prompt_text: 'What is the area of a triangle with base 6 and height 4?',
        choices: [
          { label: 'A', text: '12' },
          { label: 'B', text: '24' },
          { label: 'C', text: '10' },
          { label: 'D', text: '20' },
        ],
        correct_label: 'A',
        working: 'Half of 6 times 4.',
      },
    ],
    model: 'qwen',
  }

  beforeEach(() => {
    state.tier = 'ollama'
    state.executor = 'browser'
    state.executionSite = 'none'
  })

  it('is sifted and stored by the server, not taken as given', async () => {
    const response = await practice.PUT(put(written), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ created: 4 })
    expect(state.calls).toEqual(['accept'])
  })

  it('is a 422 when nothing in it survived the sift', async () => {
    state.generated = 0

    const response = await practice.PUT(put(written), params)

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ rejected: 1 })
  })

  it('refuses a question that is not shaped like one', async () => {
    const response = await practice.PUT(put({ questions: [{ prompt_text: '' }] }), params)

    expect(response.status).toBe(400)
    expect(state.calls).toEqual([])
  })

  it('refuses an account whose model runs on the server', async () => {
    state.tier = 'cloud'
    state.executor = 'server'
    state.executionSite = 'server'

    const response = await practice.PUT(put(written), params)

    expect(response.status).toBe(409)
    expect(state.calls).toEqual([])
  })
})

describe('the limit is spent before the model is called', () => {
  it('counts the request against the limit and then generates', async () => {
    await practice.POST(post(), params)

    expect(state.calls).toEqual(['rate-limit', 'generate'])
  })

  it('refuses without generating once the limit is spent', async () => {
    state.limited = true

    const response = await practice.POST(post(), params)

    expect(response.status).toBe(429)
    expect(state.calls).toEqual(['rate-limit'])
  })

  it('does not spend the limit on a tier that cannot generate', async () => {
    state.executor = 'none'
    state.executionSite = 'none'

    await practice.POST(post(), params)

    expect(state.calls).toEqual([])
  })
})

describe('the reply when nothing survived validation', () => {
  it('is a 422 rather than a silent success', async () => {
    state.generated = 0

    const response = await practice.POST(post(), params)

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ rejected: 1 })
  })
})

describe('the requested count', () => {
  it('refuses a count past the batch maximum', async () => {
    const response = await practice.POST(post({ count: 99 }), params)

    expect(response.status).toBe(400)
    expect(state.calls).toEqual([])
  })

  it('accepts a POST with no body at all', async () => {
    const response = await practice.POST(
      new Request('https://studybuddy.test/api/topics/topic-1/practice', { method: 'POST' }),
      params,
    )

    expect(response.status).toBe(200)
  })
})
