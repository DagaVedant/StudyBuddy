import { parseModelJson } from './json'
import {
  CLASSIFY_JSON_SCHEMA,
  CLASSIFY_SYSTEM,
  EXPLAIN_JSON_SCHEMA,
  EXPLAIN_SYSTEM,
  EXTRACTION_JSON_SCHEMA,
  EXTRACTION_SYSTEM,
  classifyUserText,
  explainUserText,
  extractionUserText,
} from './prompts'
import {
  type ExplainInput,
  type PageInput,
  type RawAIProvider,
  type TopicCandidate,
} from './types'

export interface ChatCompletionsOptions {

  endpoint?: string

  label?: string
  headers?: Record<string, string>
  fetchImpl?: typeof fetch
  name?: RawAIProvider['name']
}

export class OpenAIProvider implements RawAIProvider {
  readonly name: RawAIProvider['name']
  readonly supportsVision = true
  readonly executionSite = 'server' as const

  private readonly apiKey: string
  private readonly model: string
  private readonly fetchImpl: typeof fetch
  private readonly endpoint: string
  private readonly label: string
  private readonly headers: Record<string, string>

  constructor(
    apiKey: string,
    model = 'gpt-4.1',
    options: ChatCompletionsOptions | typeof fetch = {},
  ) {

    const resolved: ChatCompletionsOptions =
      typeof options === 'function' ? { fetchImpl: options } : options

    this.apiKey = apiKey
    this.model = model
    this.fetchImpl = resolved.fetchImpl ?? fetch
    this.endpoint = resolved.endpoint ?? 'https://api.openai.com/v1/chat/completions'
    this.label = resolved.label ?? 'OpenAI'
    this.headers = resolved.headers ?? {}
    this.name = resolved.name ?? 'openai'
  }

  private async chat(
    system: string,
    content: unknown,
    schemaName: string,
    schema: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...this.headers,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: schemaName, strict: true, schema },
        },
      }),
    })

    if (!response.ok) {
      throw new Error(`${this.label} responded ${response.status}: ${await response.text()}`)
    }

    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[]
    }

    const text = body.choices?.[0]?.message?.content
    if (!text) throw new Error(`${this.label} returned an empty response.`)

    return parseModelJson(text).value
  }

  async extractQuestions(page: PageInput): Promise<unknown> {
    const dataUrl = `data:${page.mediaType};base64,${Buffer.from(page.image).toString('base64')}`

    const raw = await this.chat(
      EXTRACTION_SYSTEM,
      [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: extractionUserText(page, page.expect ?? []) },
      ],
      'extraction',
      EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown>,
    )

    return raw
  }

  async classifyTopic(
    promptText: string,
    candidates: TopicCandidate[],
  ): Promise<unknown> {
    const raw = await this.chat(
      CLASSIFY_SYSTEM,
      classifyUserText(promptText, candidates),
      'classification',
      CLASSIFY_JSON_SCHEMA as unknown as Record<string, unknown>,
    )

    return raw
  }

  async explain(input: ExplainInput): Promise<unknown> {
    const raw = await this.chat(
      EXPLAIN_SYSTEM,
      explainUserText(input),
      'explanation',
      EXPLAIN_JSON_SCHEMA as unknown as Record<string, unknown>,
    )

    return raw
  }
}
