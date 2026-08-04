import { describe, expect, it } from 'vitest'

import { OllamaProvider } from '@/lib/ai/ollama'

const page = {
  image: new Uint8Array([1, 2, 3]),
  mediaType: 'image/png',
  text: '1. What is 2 + 2?',
  width: 100,
  height: 100,
  pageNumber: 1,
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

/** Replies with each content string in turn, recording what was sent. */
function scripted(contents: string[]) {
  const bodies: Record<string, unknown>[] = []

  const fetchImpl = (async (_url: string | URL, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    const content = contents[bodies.length - 1] ?? ''
    return new Response(JSON.stringify({ message: { content } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch

  return { bodies, fetchImpl }
}

function provider(fetchImpl: typeof fetch, maxAttempts?: number) {
  return new OllamaProvider({
    baseUrl: 'http://ollama.test',
    visionModel: 'qwen2.5vl:7b',
    textModel: 'qwen2.5vl:7b',
    fetchImpl,
    maxAttempts,
  })
}

describe('OllamaProvider empty-reply retry', () => {
  it('asks again when the model generates nothing', async () => {
    const { bodies, fetchImpl } = scripted(['', JSON.stringify(oneQuestion)])

    const questions = await provider(fetchImpl).extractQuestions(page)

    expect(bodies).toHaveLength(2)
    expect(questions).toHaveLength(1)
  })

  it('treats whitespace as nothing, since it carries no questions either', async () => {
    const { bodies, fetchImpl } = scripted(['   \n  ', JSON.stringify(oneQuestion)])

    await provider(fetchImpl).extractQuestions(page)

    expect(bodies).toHaveLength(2)
  })

  it('varies temperature on the retry so it does not repeat the same silence', async () => {
    const { bodies, fetchImpl } = scripted(['', '', JSON.stringify(oneQuestion)])

    await provider(fetchImpl).extractQuestions(page)

    const temps = bodies.map((b) => (b.options as { temperature: number }).temperature)
    expect(temps[0]).toBe(0)
    expect(temps[1]).toBeGreaterThan(0)
    expect(temps[2]).toBeGreaterThan(temps[1])
  })

  it('gives up rather than looping forever', async () => {
    const { bodies, fetchImpl } = scripted(['', '', ''])

    await expect(provider(fetchImpl).extractQuestions(page)).rejects.toThrow(
      /empty response/,
    )
    expect(bodies).toHaveLength(3)
  })

  it('honours a lower attempt limit, which is how the benchmark measures raw reliability', async () => {
    const { bodies, fetchImpl } = scripted([''])

    await expect(provider(fetchImpl, 1).extractQuestions(page)).rejects.toThrow(
      /empty response/,
    )
    expect(bodies).toHaveLength(1)
  })

  it('accepts a page that really has no questions without retrying it', async () => {
    const { bodies, fetchImpl } = scripted([JSON.stringify({ questions: [] })])

    const questions = await provider(fetchImpl).extractQuestions(page)

    expect(questions).toEqual([])
    expect(bodies).toHaveLength(1)
  })
})
