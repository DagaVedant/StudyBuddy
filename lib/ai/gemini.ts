import { parseModelJson } from './json'
import {
  ANSWER_JSON_SCHEMA,
  ANSWER_SYSTEM,
  answerUserText,
  CLASSIFY_JSON_SCHEMA,
  CLASSIFY_SYSTEM,
  classifyUserText,
  EXPLAIN_JSON_SCHEMA,
  EXPLAIN_SYSTEM,
  explainUserText,
  EXTRACTION_JSON_SCHEMA,
  EXTRACTION_SYSTEM,
  extractionUserText,
  LESSON_JSON_SCHEMA,
  LESSON_SYSTEM,
  lessonUserText,
} from './prompts'
import {
  type AnswerInput,
  type ExplainInput,
  type LessonInput,
  type PageInput,
  type RawAIProvider,
  type TopicCandidate,
} from './types'
import { CLOUD_TIMEOUT_MS, upstreamFailure, upstreamUnreachable } from './upstream'

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

export class GeminiProvider implements RawAIProvider {
  readonly name = 'google' as const
  readonly supportsVision = true
  readonly executionSite = 'server' as const

  readonly model: string

  get answeringModel(): string {
    return this.model
  }

  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch

  constructor(
    apiKey: string,
    model = 'gemini-2.5-flash',
    fetchImpl: typeof fetch = fetch,
  ) {
    this.apiKey = apiKey
    this.model = model
    this.fetchImpl = fetchImpl
  }

  private async generate(
    system: string,
    parts: unknown[],
    schema: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await this.fetchImpl(
      `${BASE}/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': this.apiKey,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: geminiSchema(schema),
          },
        }),
      },
    ).catch((error) => {
      throw upstreamUnreachable('Gemini', error)
    })

    if (!response.ok) {
      throw upstreamFailure('Gemini', response.status, await response.text())
    }

    const body = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[]
      promptFeedback?: { blockReason?: string }
    }

    const blocked = body.promptFeedback?.blockReason
    if (blocked) {
      throw new Error(`Gemini declined the page (${blocked}).`)
    }

    const text = body.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? '')
      .join('')

    if (!text) throw new Error('Gemini returned an empty response.')

    return parseModelJson(text).value
  }

  async extractQuestions(page: PageInput): Promise<unknown> {
    const raw = await this.generate(
      EXTRACTION_SYSTEM,
      [
        {
          inlineData: {
            mimeType: page.mediaType,
            data: Buffer.from(page.image).toString('base64'),
          },
        },
        { text: extractionUserText(page, page.expect ?? []) },
      ],
      EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown>,
    )

    return raw
  }

  async classifyTopic(
    promptText: string,
    candidates: TopicCandidate[],
  ): Promise<unknown> {
    const raw = await this.generate(
      CLASSIFY_SYSTEM,
      [{ text: classifyUserText(promptText, candidates) }],
      CLASSIFY_JSON_SCHEMA as unknown as Record<string, unknown>,
    )

    return raw
  }

  async answerQuestion(input: AnswerInput): Promise<unknown> {
    return this.generate(
      ANSWER_SYSTEM,
      [{ text: answerUserText(input) }],
      ANSWER_JSON_SCHEMA as unknown as Record<string, unknown>,
    )
  }

  async teachTopic(input: LessonInput): Promise<unknown> {
    return this.generate(
      LESSON_SYSTEM,
      [{ text: lessonUserText(input) }],
      LESSON_JSON_SCHEMA as unknown as Record<string, unknown>,
    )
  }

  async explain(input: ExplainInput): Promise<unknown> {
    const raw = await this.generate(
      EXPLAIN_SYSTEM,
      [{ text: explainUserText(input) }],
      EXPLAIN_JSON_SCHEMA as unknown as Record<string, unknown>,
    )

    return raw
  }
}

export function geminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set([
    'type',
    'format',
    'description',
    'nullable',
    'enum',
    'items',
    'properties',
    'required',
  ])

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk)
    if (node === null || typeof node !== 'object') return node

    const source = node as Record<string, unknown>

    if (Array.isArray(source.anyOf)) {
      const variants = source.anyOf as Record<string, unknown>[]
      const concrete = variants.filter((variant) => variant?.type !== 'null')

      if (concrete.length === 1 && concrete.length < variants.length) {
        return { ...(walk(concrete[0]) as object), nullable: true }
      }
    }

    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(source)) {
      if (!allowed.has(key)) continue
      out[key] = key === 'properties' ? mapValues(value, walk) : walk(value)
    }
    return out
  }

  return walk(schema) as Record<string, unknown>
}

function mapValues(value: unknown, fn: (input: unknown) => unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = fn(inner)
  }
  return out
}
