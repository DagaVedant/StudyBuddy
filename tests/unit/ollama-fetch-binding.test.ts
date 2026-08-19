import { afterEach, describe, expect, it, vi } from 'vitest'

import { OllamaProvider } from '@/lib/ai/ollama'

/*
 * A browser's `fetch` is a method of the window and refuses any other
 * receiver. Node's does not care, so a provider that stored `fetch` bare and
 * called it as `this.fetchImpl(...)` passed every test here and threw
 * "Illegal invocation" on the one runtime Tier C actually uses.
 *
 * This stub is the browser's rule, so the mistake cannot come back.
 */
function browserLikeFetch(onCall: (url: string) => Response) {
  return function (this: unknown, url: string | URL): Promise<Response> {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
    }

    return Promise.resolve(onCall(String(url)))
  }
}

const original = globalThis.fetch

afterEach(() => {
  globalThis.fetch = original
  vi.restoreAllMocks()
})

describe('the Ollama provider calling the global fetch', () => {
  it('lists models without handing itself over as the receiver', async () => {
    globalThis.fetch = browserLikeFetch(
      () => new Response(JSON.stringify({ models: [{ name: 'qwen2.5vl:7b' }] })),
    ) as typeof fetch

    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      visionModel: 'qwen2.5vl:7b',
      textModel: 'qwen2.5vl:7b',
      executionSite: 'browser',
    })

    await expect(provider.listModels()).resolves.toEqual(['qwen2.5vl:7b'])
  })

  it('runs a chat call the same way', async () => {
    globalThis.fetch = browserLikeFetch(
      () =>
        new Response(
          JSON.stringify({ message: { content: '{"topic_slug":null,"abstain":true}' } }),
        ),
    ) as typeof fetch

    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      visionModel: 'qwen2.5vl:7b',
      textModel: 'qwen2.5vl:7b',
      executionSite: 'browser',
    })

    await expect(
      provider.classifyTopic('What is 2 + 2?', [
        { slug: 'competition-math.algebra.linear-equations', name: 'Linear equations', path: 'x' },
      ]),
    ).resolves.toBeDefined()
  })

  it('still takes an injected fetch, which the tests and the worker rely on', async () => {
    const injected = vi.fn(async () => new Response(JSON.stringify({ models: [] })))

    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      visionModel: 'qwen2.5vl:7b',
      textModel: 'qwen2.5vl:7b',
      fetchImpl: injected as unknown as typeof fetch,
    })

    await provider.listModels()

    expect(injected).toHaveBeenCalledTimes(1)
  })
})
