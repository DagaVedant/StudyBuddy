import Anthropic from '@anthropic-ai/sdk'

import {appBaseUrl} from '@/lib/api'

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
  type AnswerInput,
  type ExecutionSite,
  type ExplainInput,
  type LessonInput,
  type PageInput,
  parseModelJson,
  type PracticeInput,
  type ProviderName,
  ProviderRefused,
  type RawAIProvider,
  type TopicCandidate,
} from './types'

const CLOUD_TIMEOUT_MS = 120000

function describeStatus(label: string, status: number) {
  if (status === 401 || status === 403) {
    return label + ' rejected the API key. Check it in settings.'
  }

  if (status === 402) {
    return label + ' reports this account is out of credit.'
  }

  if (status === 429) {
    return label + ' is rate limiting this key. Try again in a few minutes.'
  }

  if (status >= 500) {
    return label + ' is having trouble right now. Try again shortly.'
  }

  return label + ' rejected the request (HTTP ' + status + ').'
}

function upstreamFailure(label: string, status: number, body: string) {
  console.error('[ai] ' + label + ' responded ' + status + ': ' + body.slice(0, 2000))

  return new Error(describeStatus(label, status))
}

function upstreamUnreachable(label: string, cause: unknown) {
  console.error('[ai] ' + label + ' call failed:', cause)

  let name = ''
  if (cause && typeof cause === 'object') {
    const named = cause as {name?: unknown}
    if (typeof named.name === 'string') name = named.name
  }

  if (/timeout/i.test(name)) {
    const seconds = Math.round(CLOUD_TIMEOUT_MS / 1000)

    return new Error(label + ' did not answer within ' + seconds + ' seconds. Try again.')
  }

  return new Error(label + ' could not be reached. Try again shortly.')
}

type ModelRequest = {
  system: string
  userText: string
  schemaName: string
  schema: Record<string, unknown>
  maxTokens: number
  image?: {data: Uint8Array; mediaType: string}
}

abstract class CloudClient implements RawAIProvider {
  abstract readonly name: ProviderName
  readonly supportsVision = true
  readonly executionSite: ExecutionSite = 'server'
  readonly model: string

  constructor(model: string) {
    this.model = model
  }

  get answeringModel() {
    return this.model
  }

  protected abstract send(request: ModelRequest): Promise<string>

  private async ask(request: ModelRequest): Promise<unknown> {
    const reply = await this.send(request)

    return parseModelJson(reply).value
  }

  extractQuestions(page: PageInput): Promise<unknown> {
    let expect: number[] = []
    if (page.expect) expect = page.expect

    return this.ask({
      system: EXTRACTION_SYSTEM,
      userText: extractionUserText(page, expect),
      schemaName: 'extraction',
      schema: EXTRACTION_JSON_SCHEMA,
      maxTokens: 16000,
      image: {data: page.image, mediaType: page.mediaType},
    })
  }

  classifyTopic(promptText: string, candidates: TopicCandidate[]): Promise<unknown> {
    return this.ask({
      system: CLASSIFY_SYSTEM,
      userText: classifyUserText(promptText, candidates),
      schemaName: 'classification',
      schema: CLASSIFY_JSON_SCHEMA,
      maxTokens: 2000,
    })
  }

  answerQuestion(input: AnswerInput): Promise<unknown> {
    return this.ask({
      system: ANSWER_SYSTEM,
      userText: answerUserText(input),
      schemaName: 'answer',
      schema: ANSWER_JSON_SCHEMA,
      maxTokens: 4000,
    })
  }

  teachTopic(input: LessonInput): Promise<unknown> {
    return this.ask({
      system: LESSON_SYSTEM,
      userText: lessonUserText(input),
      schemaName: 'lesson',
      schema: LESSON_JSON_SCHEMA,
      maxTokens: 8000,
    })
  }

  writePractice(input: PracticeInput): Promise<unknown> {
    return this.ask({
      system: PRACTICE_SYSTEM,
      userText: practiceUserText(input),
      schemaName: 'practice',
      schema: PRACTICE_JSON_SCHEMA,
      maxTokens: 8000,
    })
  }

  explain(input: ExplainInput): Promise<unknown> {
    return this.ask({
      system: EXPLAIN_SYSTEM,
      userText: explainUserText(input),
      schemaName: 'explanation',
      schema: EXPLAIN_JSON_SCHEMA,
      maxTokens: 4000,
    })
  }
}

export class AnthropicProvider extends CloudClient {
  readonly name: ProviderName = 'anthropic'

  private readonly client: Anthropic

  constructor(apiKey: string, model: string) {
    super(model)
    this.client = new Anthropic({apiKey})
  }

  protected async send(request: ModelRequest) {
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
      let category = null
      if (response.stop_details && response.stop_details.category) {
        category = response.stop_details.category
      }

      throw new ProviderRefused(category)
    }

    let text = ''

    for (const block of response.content) {
      if (block.type === 'text') text = text + block.text
    }

    return text
  }
}

type ChatCompletionsOptions = {
  endpoint?: string
  label?: string
  headers?: Record<string, string>
  fetchImpl?: typeof fetch
  name?: ProviderName
}

export class OpenAIProvider extends CloudClient {
  readonly name: ProviderName

  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch
  private readonly endpoint: string
  private readonly label: string
  private readonly headers: Record<string, string>

  constructor(apiKey: string, model = 'gpt-4.1', options: ChatCompletionsOptions = {}) {
    super(model)

    this.apiKey = apiKey

    this.fetchImpl = fetch
    if (options.fetchImpl) this.fetchImpl = options.fetchImpl

    this.endpoint = 'https://api.openai.com/v1/chat/completions'
    if (options.endpoint) this.endpoint = options.endpoint

    this.label = 'OpenAI'
    if (options.label) this.label = options.label

    this.headers = {}
    if (options.headers) this.headers = options.headers

    this.name = 'openai'
    if (options.name) this.name = options.name
  }

  protected async send(request: ModelRequest) {
    let content: unknown = request.userText

    if (request.image) {
      const encoded = Buffer.from(request.image.data).toString('base64')
      const url = 'data:' + request.image.mediaType + ';base64,' + encoded

      content = [
        {type: 'image_url', image_url: {url}},
        {type: 'text', text: request.userText},
      ]
    }

    const headers: Record<string, string> = {
      Authorization: 'Bearer ' + this.apiKey,
      'Content-Type': 'application/json',
    }

    for (const key of Object.keys(this.headers)) headers[key] = this.headers[key]

    let response

    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
        body: JSON.stringify({
          model: this.model,
          messages: [{role: 'system', content: request.system}, {role: 'user', content}],
          response_format: {
            type: 'json_schema',
            json_schema: {name: request.schemaName, strict: true, schema: request.schema},
          },
        }),
      })
    } catch (error) {
      throw upstreamUnreachable(this.label, error)
    }

    if (!response.ok) {
      throw upstreamFailure(this.label, response.status, await response.text())
    }

    const body = (await response.json()) as {
      choices?: {message?: {content?: string}}[]
    }

    let text = ''

    if (body.choices && body.choices[0]) {
      const message = body.choices[0].message
      if (message && message.content) text = message.content
    }

    if (!text) throw new Error(this.label + ' returned an empty response.')

    return text
  }
}

export class OpenRouterProvider extends OpenAIProvider {
  constructor(apiKey: string, model = 'google/gemini-2.5-flash') {
    super(apiKey, model, {
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      label: 'OpenRouter',
      name: 'openrouter',
      headers: {'HTTP-Referer': appBaseUrl(), 'X-Title': 'StudyBuddy'},
    })
  }
}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

const GEMINI_ALLOWED_KEYS = new Set([
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'items',
  'properties',
  'required',
])

function geminiWalk(node: unknown): unknown {
  if (Array.isArray(node)) {
    const items = []
    for (const entry of node) items.push(geminiWalk(entry))

    return items
  }

  if (node === null || typeof node !== 'object') return node

  const source = node as Record<string, unknown>

  if (Array.isArray(source.anyOf)) {
    const variants = source.anyOf as Record<string, unknown>[]

    const concrete = []
    for (const variant of variants) {
      if (!variant || variant.type !== 'null') concrete.push(variant)
    }

    if (concrete.length === 1 && concrete.length < variants.length) {
      const inner = geminiWalk(concrete[0]) as Record<string, unknown>
      const withNull: Record<string, unknown> = {}

      for (const key of Object.keys(inner)) withNull[key] = inner[key]
      withNull.nullable = true

      return withNull
    }
  }

  const out: Record<string, unknown> = {}

  for (const key of Object.keys(source)) {
    if (!GEMINI_ALLOWED_KEYS.has(key)) continue

    const value = source[key]

    if (key !== 'properties') {
      out[key] = geminiWalk(value)
      continue
    }

    if (value === null || typeof value !== 'object') {
      out[key] = value
      continue
    }

    const properties: Record<string, unknown> = {}
    const inner = value as Record<string, unknown>

    for (const name of Object.keys(inner)) properties[name] = geminiWalk(inner[name])

    out[key] = properties
  }

  return out
}

function geminiSchema(schema: Record<string, unknown>) {
  return geminiWalk(schema) as Record<string, unknown>
}

export class GeminiProvider extends CloudClient {
  readonly name: ProviderName = 'google'

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

  protected async send(request: ModelRequest) {
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

    const url = GEMINI_BASE + '/' + encodeURIComponent(this.model) + ':generateContent'

    let response

    try {
      response = await this.fetchImpl(url, {
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
      })
    } catch (error) {
      throw upstreamUnreachable('Gemini', error)
    }

    if (!response.ok) {
      throw upstreamFailure('Gemini', response.status, await response.text())
    }

    const body = (await response.json()) as {
      candidates?: {content?: {parts?: {text?: string}[]}}[]
      promptFeedback?: {blockReason?: string}
    }

    if (body.promptFeedback && body.promptFeedback.blockReason) {
      throw new Error('Gemini declined the page (' + body.promptFeedback.blockReason + ').')
    }

    let text = ''

    if (body.candidates && body.candidates[0]) {
      const content = body.candidates[0].content

      if (content && content.parts) {
        for (const part of content.parts) {
          if (part.text) text = text + part.text
        }
      }
    }

    if (!text) throw new Error('Gemini returned an empty response.')

    return text
  }
}
