/**
 * The four cloud providers, against the one interface they implement.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnthropicProvider } from '@/lib/ai/anthropic'
import { CLASSIFY_JSON_SCHEMA, EXPLAIN_JSON_SCHEMA, EXTRACTION_JSON_SCHEMA, EXTRACTION_SYSTEM, REVIEW_JSON_SCHEMA } from '@/lib/ai/prompts'
import { ProviderRefused } from '@/lib/ai/types'
import { GeminiProvider, geminiSchema } from '@/lib/ai/gemini'
import { validated } from '@/lib/ai/validated'
import { OpenAIProvider } from '@/lib/ai/openai'
import { OpenRouterProvider } from '@/lib/ai/openrouter'

describe('anthropic', () => {
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
})

describe('openai, openrouter and gemini', () => {
const page = {
  image: new Uint8Array([1, 2, 3]),
  mediaType: 'image/png',
  text: '1. What is 2 + 2?',
  width: 100,
  height: 100,
  pageNumber: 1,
}

function recorder(body: unknown) {
  const calls: { url: string; init: RequestInit }[] = []

  const fetchImpl = (async (url: string | URL, init: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch

  return { calls, fetchImpl }
}

function chatReply(payload: unknown) {
  return { choices: [{ message: { content: JSON.stringify(payload) } }] }
}

function geminiReply(payload: unknown) {
  return { candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }
}

const oneQuestion = {
  questions: [
    {
      ordinal: 1,
      prompt_text: 'What is 2 + 2?',
      question_type: 'multiple_choice',
      choices: [{ label: 'A', text: '4' }],
      bbox: null,
      has_figure: false,
    },
  ],
}

describe('OpenRouterProvider', () => {
  it('talks to OpenRouter, not OpenAI', async () => {
    const { calls, fetchImpl } = recorder(chatReply(oneQuestion))
    const provider = new OpenRouterProvider('sk-or-test', 'anthropic/claude-sonnet-5', 'https://app.test', fetchImpl)

    await provider.extractQuestions(page)

    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(JSON.parse(String(calls[0].init.body)).model).toBe('anthropic/claude-sonnet-5')
  })

  it('identifies the app, since OpenRouter attributes traffic by it', async () => {
    const { calls, fetchImpl } = recorder(chatReply(oneQuestion))
    const provider = new OpenRouterProvider('sk-or-test', undefined, 'https://app.test', fetchImpl)

    await provider.extractQuestions(page)

    const headers = calls[0].init.headers as Record<string, string>
    expect(headers['HTTP-Referer']).toBe('https://app.test')
    expect(headers['X-Title']).toBe('StudyBuddy')
    expect(headers.Authorization).toBe('Bearer sk-or-test')
  })

  it('reports its own name so a failure does not blame OpenAI', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = (async () =>
      new Response('nope', { status: 402 })) as unknown as typeof fetch

    const provider = new OpenRouterProvider('sk-or-test', undefined, 'https://app.test', fetchImpl)

    await expect(provider.extractQuestions(page)).rejects.toThrow(/OpenRouter/)

    error.mockRestore()
  })
})

describe('an upstream that says no', () => {
  function failing(status: number, body: string) {
    return (async () => new Response(body, { status })) as unknown as typeof fetch
  }

  // The message on this error is rendered verbatim on the worksheet status
  // page, so the body has to stay out of it. It goes to the log instead.
  it('keeps the response body off the student’s screen', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const body = '{"error":{"message":"org-7f3a exceeded quota at /internal/v2/route"}}'

    const provider = new OpenAIProvider('sk-test', 'gpt-4.1', {
      fetchImpl: failing(429, body),
    })

    await expect(provider.extractQuestions(page)).rejects.toThrow(
      /rate limiting this key/,
    )
    await expect(provider.extractQuestions(page)).rejects.not.toThrow(/internal\/v2/)

    expect(error).toHaveBeenCalledWith(expect.stringContaining('org-7f3a'))
    error.mockRestore()
  })

  it('says which of the two things to do about a rejected key', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const provider = new GeminiProvider('AIza-test', 'gemini-2.5-flash', failing(401, 'no'))

    await expect(provider.extractQuestions(page)).rejects.toThrow(/key.*settings/i)

    error.mockRestore()
  })

  it('does not wait on an upstream forever', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const fetchImpl = (async (_url: string, init: RequestInit) => {
      // Whatever the deadline is, the request has to carry one. Without it a
      // hung upstream holds a pool connection for the whole invocation.
      expect(init.signal).toBeInstanceOf(AbortSignal)
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' })
    }) as unknown as typeof fetch

    await expect(
      new OpenAIProvider('sk-test', 'gpt-4.1', { fetchImpl }).extractQuestions(page),
    ).rejects.toThrow(/did not answer within/)

    error.mockRestore()
  })
})

describe('OpenAIProvider', () => {
  it('still defaults to OpenAI', async () => {
    const { calls, fetchImpl } = recorder(chatReply(oneQuestion))
    await new OpenAIProvider('sk-test', 'gpt-4.1', { fetchImpl }).extractQuestions(page)

    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions')
  })

  it('accepts a bare fetch as its third argument', async () => {
    const { calls, fetchImpl } = recorder(chatReply(oneQuestion))
    await new OpenAIProvider('sk-test', 'gpt-4.1', fetchImpl).extractQuestions(page)

    expect(calls).toHaveLength(1)
  })
})

describe('GeminiProvider', () => {
  it('sends the image inline and asks for JSON against a schema', async () => {
    const { calls, fetchImpl } = recorder(geminiReply(oneQuestion))
    const provider = new GeminiProvider('AIza-test', 'gemini-2.5-flash', fetchImpl)

    const questions = await validated(provider).extractQuestions(page)

    expect(questions).toHaveLength(1)
    expect(calls[0].url).toContain('gemini-2.5-flash:generateContent')

    const body = JSON.parse(String(calls[0].init.body))
    expect(body.contents[0].parts[0].inlineData.mimeType).toBe('image/png')
    expect(body.generationConfig.responseMimeType).toBe('application/json')
    expect(body.generationConfig.responseSchema).toBeTruthy()
  })

  it('sends the key as a header, never in the URL', async () => {
    const { calls, fetchImpl } = recorder(geminiReply(oneQuestion))
    await new GeminiProvider('AIza-secret', 'gemini-2.5-flash', fetchImpl).extractQuestions(page)

    expect(calls[0].url).not.toContain('AIza-secret')
    expect((calls[0].init.headers as Record<string, string>)['x-goog-api-key']).toBe(
      'AIza-secret',
    )
  })

  it('surfaces a blocked prompt rather than an empty-response error', async () => {
    const { fetchImpl } = recorder({ promptFeedback: { blockReason: 'SAFETY' } })

    await expect(
      new GeminiProvider('AIza-test', 'gemini-2.5-flash', fetchImpl).extractQuestions(page),
    ).rejects.toThrow(/SAFETY/)
  })
})

describe('geminiSchema', () => {

  it('strips keywords Gemini rejects', () => {
    const cleaned = JSON.stringify(
      geminiSchema(EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown>),
    )

    expect(cleaned).not.toContain('additionalProperties')
    expect(cleaned).not.toContain('$schema')
  })

  it('keeps the structure the reply is validated against', () => {
    const cleaned = geminiSchema(
      EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown>,
    ) as { type?: string; properties?: Record<string, unknown> }

    expect(cleaned.type).toBe('object')
    expect(cleaned.properties?.questions).toBeTruthy()
  })

  it('recurses into nested properties rather than only the top level', () => {
    const cleaned = geminiSchema({
      type: 'object',
      additionalProperties: false,
      properties: {
        outer: {
          type: 'object',
          additionalProperties: false,
          properties: { inner: { type: 'string', additionalProperties: false } },
        },
      },
    })

    expect(JSON.stringify(cleaned)).not.toContain('additionalProperties')
    expect(JSON.stringify(cleaned)).toContain('inner')
  })

  /**
   * The failure this guards was total and silent. Every nullable field in every
   * schema is written `anyOf: [{ type: 'T' }, { type: 'null' }]`; the allow-list
   * dropped `anyOf` and left `{}` behind while the field stayed in `required`.
   * Gemini wants a type on every node, so a required property with no type is a
   * rejected request, and the provider had never completed a single call.
   *
   * Stated as "every node has a type" rather than as the string `{}` not
   * appearing, because that string is also absent from a schema that lost a
   * whole subtree, and losing a subtree is the other way to break this.
   */
  describe('nullable fields', () => {
    /** Every schema node reachable through properties or items with no `type`. */
    function typeless(schema: unknown, path = '$'): string[] {
      if (schema === null || typeof schema !== 'object') return []

      const node = schema as Record<string, unknown>
      const here = typeof node.type === 'string' ? [] : [path]

      const children: string[] = []
      if (node.properties && typeof node.properties === 'object') {
        for (const [name, child] of Object.entries(
          node.properties as Record<string, unknown>,
        )) {
          children.push(...typeless(child, `${path}.${name}`))
        }
      }
      if (node.items) children.push(...typeless(node.items, `${path}[]`))

      return [...here, ...children]
    }

    it.each([
      ['extraction', EXTRACTION_JSON_SCHEMA],
      ['classification', CLASSIFY_JSON_SCHEMA],
      ['explanation', EXPLAIN_JSON_SCHEMA],
      ['review', REVIEW_JSON_SCHEMA],
    ])('leaves no node without a type in the %s schema', (_name, schema) => {
      const cleaned = geminiSchema(schema as unknown as Record<string, unknown>)

      expect(typeless(cleaned)).toEqual([])
    })

    it('turns a T-or-null union into the nullable Gemini understands', () => {
      expect(
        geminiSchema({
          type: 'object',
          properties: { note: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
          required: ['note'],
        }),
      ).toEqual({
        type: 'object',
        properties: { note: { type: 'string', nullable: true } },
        required: ['note'],
      })
    })

    it('keeps the inner shape of a nullable array rather than flattening it', () => {
      const cleaned = geminiSchema({
        type: 'object',
        properties: {
          bbox: {
            anyOf: [{ type: 'array', items: { type: 'number' } }, { type: 'null' }],
          },
        },
      }) as { properties: { bbox: Record<string, unknown> } }

      expect(cleaned.properties.bbox).toEqual({
        type: 'array',
        items: { type: 'number' },
        nullable: true,
      })
    })

    it('still strips the keywords Gemini rejects from inside a union', () => {
      const cleaned = geminiSchema({
        type: 'object',
        properties: {
          nested: {
            anyOf: [
              { type: 'object', additionalProperties: false, properties: {} },
              { type: 'null' },
            ],
          },
        },
      })

      expect(JSON.stringify(cleaned)).not.toContain('additionalProperties')
    })

    /**
     * A union of two concrete types has no Gemini equivalent. Guessing one of
     * them would quietly narrow what the model is allowed to answer, so it is
     * left alone to fail upstream where somebody can see it. Nothing in these
     * four schemas has one; this records the choice.
     */
    it('leaves a union of two real types alone', () => {
      const cleaned = geminiSchema({
        type: 'object',
        properties: { odd: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
      }) as { properties: { odd: Record<string, unknown> } }

      expect(cleaned.properties.odd.nullable).toBeUndefined()
    })
  })
})
})
