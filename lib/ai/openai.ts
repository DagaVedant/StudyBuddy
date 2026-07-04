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
  classificationSchema,
  explanationSchema,
  parseExtraction,
  type AIProvider,
  type Classification,
  type ExplainInput,
  type ExtractedQuestion,
  type Explanation,
  type PageInput,
  type TopicCandidate,
} from './types'

export interface ChatCompletionsOptions {
  /** Defaults to OpenAI. OpenRouter serves the same protocol elsewhere. */
  endpoint?: string
  /** Used in error messages so a failure names the service the user chose. */
  label?: string
  headers?: Record<string, string>
  fetchImpl?: typeof fetch
  name?: AIProvider['name']
}

/**
 * Tier B over the Chat Completions protocol, via plain fetch rather than a
 * vendor SDK for three calls.
 *
 * OpenAI defined this shape and OpenRouter implements it, so both run through
 * this one client with a different endpoint — see OpenRouterProvider. Gemini
 * is not here: its structured output is a first-class request field rather
 * than a compatibility shim, so it gets its own client (./gemini).
 */
export class OpenAIProvider implements AIProvider {
  readonly name: AIProvider['name']
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
    // The third argument used to be a bare fetch; keep that call shape working.
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

    // A hosted model can still stop mid-string at its output cap; keep the
    // complete entries rather than losing the page.
    return parseModelJson(text).value
  }

  async extractQuestions(page: PageInput): Promise<ExtractedQuestion[]> {
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

    return parseExtraction(raw).questions
  }

  async classifyTopic(
    promptText: string,
    candidates: TopicCandidate[],
  ): Promise<Classification> {
    const raw = await this.chat(
      CLASSIFY_SYSTEM,
      classifyUserText(promptText, candidates),
      'classification',
      CLASSIFY_JSON_SCHEMA as unknown as Record<string, unknown>,
    )

    return classificationSchema.parse(raw)
  }

  async explain(input: ExplainInput): Promise<Explanation> {
    const raw = await this.chat(
      EXPLAIN_SYSTEM,
      explainUserText(input),
      'explanation',
      EXPLAIN_JSON_SCHEMA as unknown as Record<string, unknown>,
    )

    return explanationSchema.parse(raw)
  }
}
