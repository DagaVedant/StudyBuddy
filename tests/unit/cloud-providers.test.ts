import { describe, expect, it } from 'vitest'

import { GeminiProvider, geminiSchema } from '@/lib/ai/gemini'
import { validated } from '@/lib/ai/validated'
import { OpenAIProvider } from '@/lib/ai/openai'
import { OpenRouterProvider } from '@/lib/ai/openrouter'
import { EXTRACTION_JSON_SCHEMA } from '@/lib/ai/prompts'

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
    const fetchImpl = (async () =>
      new Response('nope', { status: 402 })) as unknown as typeof fetch

    const provider = new OpenRouterProvider('sk-or-test', undefined, 'https://app.test', fetchImpl)

    await expect(provider.extractQuestions(page)).rejects.toThrow(/OpenRouter responded 402/)
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
})
