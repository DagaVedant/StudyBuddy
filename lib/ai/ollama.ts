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
  type ExecutionSite,
  type ExplainInput,
  type ExtractedQuestion,
  type Explanation,
  type PageInput,
  type TopicCandidate,
} from './types'

export interface OllamaOptions {
  baseUrl: string
  visionModel: string
  textModel: string
  /**
   * Tier C runs in the browser against the student's own localhost; the
   * operator GPU worker runs the same code server-side (spec §3.3, §3.4).
   */
  executionSite?: ExecutionSite
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Ollama's 4096 default truncates dense pages mid-JSON. */
  contextTokens?: number
  maxOutputTokens?: number
}

/**
 * Ollama, used for both Tier C (student's own GPU, browser-side) and the
 * operator GPU worker (Tier 0, server-side). Identical wire protocol; only
 * where it runs differs.
 */
export class OllamaProvider implements AIProvider {
  readonly name = 'ollama' as const
  readonly supportsVision = true
  readonly executionSite: ExecutionSite

  private readonly baseUrl: string
  private readonly visionModel: string
  private readonly textModel: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly contextTokens: number
  private readonly maxOutputTokens: number

  constructor(options: OllamaOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.visionModel = options.visionModel
    this.textModel = options.textModel
    this.executionSite = options.executionSite ?? 'browser'
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000
    this.contextTokens = options.contextTokens ?? 16_384
    this.maxOutputTokens = options.maxOutputTokens ?? 4_096
  }

  /** Ollama's /api/chat with `format` set to a JSON Schema constrains decoding. */
  private async chat(
    model: string,
    system: string,
    userText: string,
    images: string[] | undefined,
    schema: Record<string, unknown>,
  ): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          stream: false,
          format: schema,
          options: {
            temperature: 0,
            /*
             * Ollama defaults num_ctx to 4096, which a dense exam page blows
             * through: image tokens plus page text plus a long JSON array of
             * questions. Generation then stops mid-string and the reply fails
             * to parse ("Unterminated string in JSON"), losing the whole page.
             * qwen2.5vl handles 32k, so give it real headroom.
             */
            num_ctx: this.contextTokens,
            num_predict: this.maxOutputTokens,
          },
          messages: [
            { role: 'system', content: system },
            images?.length
              ? { role: 'user', content: userText, images }
              : { role: 'user', content: userText },
          ],
        }),
      })

      if (!response.ok) {
        throw new Error(
          `Ollama responded ${response.status}. Is it running, and is ${model} pulled?`,
        )
      }

      const body = (await response.json()) as { message?: { content?: string } }
      const content = body.message?.content
      if (!content) throw new Error('Ollama returned an empty response.')

      return JSON.parse(content)
    } finally {
      clearTimeout(timer)
    }
  }

  async extractQuestions(page: PageInput): Promise<ExtractedQuestion[]> {
    const raw = await this.chat(
      this.visionModel,
      EXTRACTION_SYSTEM,
      extractionUserText(page),
      [Buffer.from(page.image).toString('base64')],
      EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown>,
    )

    return parseExtraction(raw).questions
  }

  async classifyTopic(
    promptText: string,
    candidates: TopicCandidate[],
  ): Promise<Classification> {
    const raw = await this.chat(
      this.textModel,
      CLASSIFY_SYSTEM,
      classifyUserText(promptText, candidates),
      undefined,
      CLASSIFY_JSON_SCHEMA as unknown as Record<string, unknown>,
    )

    return classificationSchema.parse(raw)
  }

  async explain(input: ExplainInput): Promise<Explanation> {
    const raw = await this.chat(
      this.textModel,
      EXPLAIN_SYSTEM,
      explainUserText(input),
      undefined,
      EXPLAIN_JSON_SCHEMA as unknown as Record<string, unknown>,
    )

    return explanationSchema.parse(raw)
  }

  /** Used by the settings connection test and the worker heartbeat. */
  async listModels(): Promise<string[]> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/tags`)
    if (!response.ok) throw new Error(`Ollama responded ${response.status}`)
    const body = (await response.json()) as { models?: { name: string }[] }
    return (body.models ?? []).map((model) => model.name)
  }
}
