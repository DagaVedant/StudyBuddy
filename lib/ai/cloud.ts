import Anthropic from '@anthropic-ai/sdk'

import {appBaseUrl} from '@/lib/api'

import {parseModelJson} from './types'
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
  PRACTICE_JSON_SCHEMA,
  PRACTICE_SYSTEM,
  practiceUserText,
} from './prompts'
import {
  ProviderRefused,
  type AnswerInput,
  type ExplainInput,
  type LessonInput,
  type PageInput,
  type PracticeInput,
  type RawAIProvider,
  type TopicCandidate,
} from './types'

export const CLOUD_TIMEOUT_MS = 120_000

export function upstreamFailure(label: string, status: number, body: string): Error {
  console.error(`[ai] ${label} responded ${status}: ${body.slice(0, 2000)}`)
  return new Error(describeStatus(label, status))
}

function describeStatus(label: string, status: number): string {
  if (status === 401 || status === 403) {
    return `${label} rejected the API key. Check it in settings.`
  }
  if (status === 402) {
    return `${label} reports this account is out of credit.`
  }
  if (status === 429) {
    return `${label} is rate limiting this key. Try again in a few minutes.`
  }
  if (status >= 500) {
    return `${label} is having trouble right now. Try again shortly.`
  }
  return `${label} rejected the request (HTTP ${status}).`
}

export function upstreamUnreachable(label: string, cause: unknown): Error {
  console.error(`[ai] ${label} call failed:`, cause)

  const name = (cause as {name?: unknown} | null | undefined)?.name
  const timedOut = typeof name === 'string' && /timeout/i.test(name)

  return new Error(
    timedOut
      ? `${label} did not answer within ${Math.round(CLOUD_TIMEOUT_MS / 1000)} seconds. Try again.`
      : `${label} could not be reached. Try again shortly.`,
  )
}

export interface ModelRequest {
  system: string
  userText: string
  schemaName: string
  schema: Record<string, unknown>
  maxTokens: number
  image?: {data: Uint8Array; mediaType: string}
}

function asSchema(schema: unknown): Record<string, unknown> {
  return schema as Record<string, unknown>
}

export abstract class CloudClient implements RawAIProvider {
  abstract readonly name: RawAIProvider['name']
  readonly supportsVision = true
  readonly executionSite = 'server' as const
  readonly model: string

  constructor(model: string) {
    this.model = model
  }

  get answeringModel(): string {
    return this.model
  }

  protected abstract send(request: ModelRequest): Promise<string>

  private async ask(request: ModelRequest): Promise<unknown> {
    return parseModelJson(await this.send(request)).value
  }

  extractQuestions(page: PageInput): Promise<unknown> {
    return this.ask({
      system: EXTRACTION_SYSTEM,
      userText: extractionUserText(page, page.expect ?? []),
      schemaName: 'extraction',
      schema: asSchema(EXTRACTION_JSON_SCHEMA),
      maxTokens: 16000,
      image: {data: page.image, mediaType: page.mediaType},
    })
  }

  classifyTopic(promptText: string, candidates: TopicCandidate[]): Promise<unknown> {
    return this.ask({
      system: CLASSIFY_SYSTEM,
      userText: classifyUserText(promptText, candidates),
      schemaName: 'classification',
      schema: asSchema(CLASSIFY_JSON_SCHEMA),
      maxTokens: 2000,
    })
  }

  answerQuestion(input: AnswerInput): Promise<unknown> {
    return this.ask({
      system: ANSWER_SYSTEM,
      userText: answerUserText(input),
      schemaName: 'answer',
      schema: asSchema(ANSWER_JSON_SCHEMA),
      maxTokens: 4000,
    })
  }

  teachTopic(input: LessonInput): Promise<unknown> {
    return this.ask({
      system: LESSON_SYSTEM,
      userText: lessonUserText(input),
      schemaName: 'lesson',
      schema: asSchema(LESSON_JSON_SCHEMA),
      maxTokens: 8000,
    })
  }

  writePractice(input: PracticeInput): Promise<unknown> {
    return this.ask({
      system: PRACTICE_SYSTEM,
      userText: practiceUserText(input),
      schemaName: 'practice',
      schema: asSchema(PRACTICE_JSON_SCHEMA),
      maxTokens: 8000,
    })
  }

  explain(input: ExplainInput): Promise<unknown> {
    return this.ask({
      system: EXPLAIN_SYSTEM,
      userText: explainUserText(input),
      schemaName: 'explanation',
      schema: asSchema(EXPLAIN_JSON_SCHEMA),
      maxTokens: 4000,
    })
  }
}

export class AnthropicProvider extends CloudClient {
  readonly name = 'anthropic' as const

  private readonly client: Anthropic

  constructor(apiKey: string, model: string) {
    super(model)
    this.client = new Anthropic({apiKey})
  }

  protected async send(request: ModelRequest): Promise<string> {
    const content: Anthropic.ContentBlockParam[] = []

    if (request.image) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: request.image.mediaType as 'image/webp',
          data: Buffer.from(request.image.data).toString('base64'),
        },
      })
    }

    content.push({type: 'text', text: request.userText})

    let response: Anthropic.Message
    try {
      response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: [{role: 'user', content}],
          output_config: {format: {type: 'json_schema', schema: request.schema} as never},
        },
        {timeout: CLOUD_TIMEOUT_MS},
      )
    } catch (error) {
      if (error instanceof Anthropic.APIError && typeof error.status === 'number') {
        throw upstreamFailure('Anthropic', error.status, error.message)
      }
      throw upstreamUnreachable('Anthropic', error)
    }

    if (response.stop_reason === 'refusal') {
      throw new ProviderRefused(response.stop_details?.category ?? null)
    }

    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
  }
}

export interface ChatCompletionsOptions {
  endpoint?: string
  label?: string
  headers?: Record<string, string>
  fetchImpl?: typeof fetch
  name?: RawAIProvider['name']
}

export class OpenAIProvider extends CloudClient {
  readonly name: RawAIProvider['name']

  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch
  private readonly endpoint: string
  private readonly label: string
  private readonly headers: Record<string, string>

  constructor(
    apiKey: string,
    model = 'gpt-4.1',
    options: ChatCompletionsOptions | typeof fetch = {},
  ) {
    super(model)

    const resolved: ChatCompletionsOptions =
      typeof options === 'function' ? {fetchImpl: options} : options

    this.apiKey = apiKey
    this.fetchImpl = resolved.fetchImpl ?? fetch
    this.endpoint = resolved.endpoint ?? 'https://api.openai.com/v1/chat/completions'
    this.label = resolved.label ?? 'OpenAI'
    this.headers = resolved.headers ?? {}
    this.name = resolved.name ?? 'openai'
  }

  protected async send(request: ModelRequest): Promise<string> {
    const content = request.image
      ? [
          {
            type: 'image_url',
            image_url: {
              url: `data:${request.image.mediaType};base64,${Buffer.from(request.image.data).toString('base64')}`,
            },
          },
          {type: 'text', text: request.userText},
        ]
      : request.userText

    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...this.headers,
      },
      signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
      body: JSON.stringify({
        model: this.model,
        messages: [{role: 'system', content: request.system}, {role: 'user', content}],
        response_format: {
          type: 'json_schema',
          json_schema: {name: request.schemaName, strict: true, schema: request.schema},
        },
      }),
    }).catch((error) => {
      throw upstreamUnreachable(this.label, error)
    })

    if (!response.ok) {
      throw upstreamFailure(this.label, response.status, await response.text())
    }

    const body = (await response.json()) as {
      choices?: {message?: {content?: string}}[]
    }

    const text = body.choices?.[0]?.message?.content
    if (!text) throw new Error(`${this.label} returned an empty response.`)

    return text
  }
}

export class OpenRouterProvider extends OpenAIProvider {
  constructor(
    apiKey: string,
    model = 'google/gemini-2.5-flash',
    appUrl = appBaseUrl(),
    fetchImpl: typeof fetch = fetch,
  ) {
    super(apiKey, model, {
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      label: 'OpenRouter',
      name: 'openrouter',
      fetchImpl,
      headers: {'HTTP-Referer': appUrl, 'X-Title': 'StudyBuddy'},
    })
  }
}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

export class GeminiProvider extends CloudClient {
  readonly name = 'google' as const

  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch

  constructor(
    apiKey: string,
    model = 'gemini-2.5-flash',
    fetchImpl: typeof fetch = fetch,
  ) {
    super(model)
    this.apiKey = apiKey
    this.fetchImpl = fetchImpl
  }

  protected async send(request: ModelRequest): Promise<string> {
    const parts: unknown[] = []

    if (request.image) {
      parts.push({
        inlineData: {
          mimeType: request.image.mediaType,
          data: Buffer.from(request.image.data).toString('base64'),
        },
      })
    }

    parts.push({text: request.userText})

    const response = await this.fetchImpl(
      `${GEMINI_BASE}/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: 'POST',
        headers: {'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json'},
        signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
        body: JSON.stringify({
          systemInstruction: {parts: [{text: request.system}]},
          contents: [{role: 'user', parts}],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: geminiSchema(request.schema),
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
      candidates?: {content?: {parts?: {text?: string}[]}}[]
      promptFeedback?: {blockReason?: string}
    }

    const blocked = body.promptFeedback?.blockReason
    if (blocked) {
      throw new Error(`Gemini declined the page (${blocked}).`)
    }

    const text = body.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? '')
      .join('')

    if (!text) throw new Error('Gemini returned an empty response.')

    return text
  }
}

export function geminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set([
    'type', 'format', 'description', 'nullable', 'enum', 'items', 'properties', 'required',
  ])

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk)
    if (node === null || typeof node !== 'object') return node

    const source = node as Record<string, unknown>

    if (Array.isArray(source.anyOf)) {
      const variants = source.anyOf as Record<string, unknown>[]
      const concrete = variants.filter((variant) => variant?.type !== 'null')

      if (concrete.length === 1 && concrete.length < variants.length) {
        return {...(walk(concrete[0]) as object), nullable: true}
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
