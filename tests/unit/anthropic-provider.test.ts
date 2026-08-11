import { afterEach, describe, expect, it, vi } from 'vitest'

import { AnthropicProvider } from '@/lib/ai/anthropic'
import { EXTRACTION_SYSTEM } from '@/lib/ai/prompts'
import { ProviderRefused } from '@/lib/ai/types'

/**
 * The default cloud provider, and the only one of the four with no test.
 *
 * `cloud-providers.test.ts` covers OpenAI, OpenRouter and Gemini because those
 * three call `fetch` directly and are trivial to record. This one goes through
 * the Anthropic SDK, which is presumably why it was skipped, and it is the one
 * `DEFAULT_CLOUD_MODEL` points at.
 */

const page = {
  image: new Uint8Array([1, 2, 3]),
  mediaType: 'image/webp',
  text: '1. What is 2 + 2?',
  width: 100,
  height: 100,
  pageNumber: 1,
}

const oneQuestion = {
  questions: [
    {
      promptText: 'What is 2 + 2?',
      printedNumber: '1',
      choices: [
        { label: 'A', text: '3' },
        { label: 'B', text: '4' },
      ],
      box: { x: 0, y: 0, width: 10, height: 10 },
    },
  ],
}

function message(body: unknown, stop: Record<string, unknown> = {}) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: [{ type: 'text', text: JSON.stringify(body) }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
    ...stop,
  }
}

function recorder(reply: () => Response) {
  const calls: { url: string; init: RequestInit }[] = []

  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input instanceof Request ? input.url : input), init })
    return reply()
  }) as unknown as typeof fetch

  vi.stubGlobal('fetch', impl)
  return calls
}

function ok(body: unknown, stop: Record<string, unknown> = {}) {
  return () =>
    new Response(JSON.stringify(message(body, stop)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
}

function failure(status: number, body: string) {
  return () =>
    new Response(body, { status, headers: { 'Content-Type': 'application/json' } })
}

function provider() {
  return new AnthropicProvider('sk-ant-test', 'claude-opus-5')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AnthropicProvider', () => {
  it('names itself, runs on the server, and takes images', () => {
    const anthropic = provider()

    expect(anthropic.name).toBe('anthropic')
    expect(anthropic.executionSite).toBe('server')
    expect(anthropic.supportsVision).toBe(true)
  })

  it('sends the page as a base64 image beside the extraction prompt', async () => {
    const calls = recorder(ok(oneQuestion))

    await provider().extractQuestions(page)

    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>
    expect(body.model).toBe('claude-opus-5')
    expect(body.system).toBe(EXTRACTION_SYSTEM)

    const content = (body.messages as { content: Record<string, never>[] }[])[0].content
    expect(content[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/webp' },
    })
    expect(content[1]).toMatchObject({ type: 'text' })
  })

  /**
   * The model is required by the constructor, and this is why. There used to be
   * a default here as well as one in `DEFAULT_CLOUD_MODEL` and they disagreed,
   * so a call that skipped the table billed a model the settings screen never
   * mentioned.
   */
  it('bills the model it was given, not one of its own', async () => {
    const calls = recorder(ok(oneQuestion))

    await new AnthropicProvider('sk-ant-test', 'claude-haiku-4-5').extractQuestions(page)

    expect(JSON.parse(String(calls[0].init.body)).model).toBe('claude-haiku-4-5')
  })

  it('asks for a schema-shaped response', async () => {
    const calls = recorder(ok(oneQuestion))

    await provider().extractQuestions(page)

    const body = JSON.parse(String(calls[0].init.body)) as {
      output_config?: { format?: { type?: string; schema?: unknown } }
    }
    expect(body.output_config?.format?.type).toBe('json_schema')
    expect(body.output_config?.format?.schema).toBeTruthy()
  })

  it('gives classification and explanation smaller budgets than extraction', async () => {
    const calls = recorder(ok({ topicId: null, confidence: 0.1, reason: 'x' }))

    await provider().extractQuestions(page)
    await provider().classifyTopic('What is 2 + 2?', [])
    await provider().explain({
      promptText: 'What is 2 + 2?',
      correctAnswer: '4',
      studentAnswer: '3',
      choices: [],
    })

    const budgets = calls.map((call) => JSON.parse(String(call.init.body)).max_tokens)
    expect(budgets[0]).toBeGreaterThan(budgets[1])
    expect(budgets[0]).toBeGreaterThan(budgets[2])
  })

  /**
   * A schema-shaped response is still a string the model wrote. `\frac` is not
   * valid JSON escaping, and a bare `JSON.parse` throws on it, which turned a
   * page of algebra into a failed job rather than a page of algebra.
   */
  it('recovers a response carrying raw LaTeX escapes', async () => {
    recorder(
      () =>
        new Response(
          JSON.stringify({
            ...message({}),
            content: [
              {
                type: 'text',
                text: '{"questions":[{"promptText":"Simplify \\frac{1}{2}"}]}',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    )

    const raw = (await provider().extractQuestions(page)) as {
      questions: { promptText: string }[]
    }

    expect(raw.questions[0].promptText).toContain('frac')
  })

  it('raises ProviderRefused with the category when the model refuses', async () => {
    recorder(
      ok({}, { stop_reason: 'refusal', stop_details: { category: 'copyright' } }),
    )

    await expect(provider().extractQuestions(page)).rejects.toBeInstanceOf(ProviderRefused)
  })

  it('tolerates a refusal that names no category', async () => {
    recorder(ok({}, { stop_reason: 'refusal' }))

    await expect(provider().extractQuestions(page)).rejects.toBeInstanceOf(ProviderRefused)
  })

  /**
   * The message on these errors is not for a log. It is stored on the job and
   * rendered on the student's status page, so the provider's response body must
   * not survive into it: an auth error arrives as a JSON blob naming headers.
   */
  it('translates a rejected key without echoing the body', async () => {
    const secret = 'x-api-key header sk-ant-leaked-0123456789 was invalid'
    recorder(failure(401, JSON.stringify({ error: { message: secret } })))

    await expect(provider().extractQuestions(page)).rejects.toThrow(
      'Anthropic rejected the API key. Check it in settings.',
    )
    await expect(provider().extractQuestions(page)).rejects.not.toThrow(
      /sk-ant-leaked/,
    )
  })

  it('translates an account with no credit', async () => {
    recorder(failure(402, '{}'))

    await expect(provider().extractQuestions(page)).rejects.toThrow(/out of credit/)
  })

  it('says a network failure is not the student\'s fault', async () => {
    vi.stubGlobal(
      'fetch',
      (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch,
    )

    await expect(provider().extractQuestions(page)).rejects.toThrow(
      'Anthropic could not be reached. Try again shortly.',
    )
  })
})
