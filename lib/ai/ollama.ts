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
import { parseModelJson } from './json'
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

/**
 * Timing and token counts Ollama reports alongside every reply.
 *
 * Durations are nanoseconds, which is what the API returns; dividing
 * evalCount by evalDurationNs gives generation tokens per second.
 */
export interface OllamaCallStats {
  model: string
  promptTokens: number
  evalTokens: number
  promptDurationNs: number
  evalDurationNs: number
  totalDurationNs: number
  /** Time spent bringing the model into memory — large when it is offloaded. */
  loadDurationNs: number
}

export interface OllamaOptions {
  baseUrl: string
  visionModel: string
  textModel: string

  executionSite?: ExecutionSite
  fetchImpl?: typeof fetch
  timeoutMs?: number

  contextTokens?: number
  maxOutputTokens?: number

  /**
   * Observability hook, unset in normal use. Ollama reports token counts and
   * durations on every reply and the provider used to drop them; the
   * benchmark needs them to report tokens/sec, and there is no way to
   * recover them after the fact.
   */
  onStats?: (stats: OllamaCallStats) => void
}

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
  private readonly onStats?: (stats: OllamaCallStats) => void

  constructor(options: OllamaOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.visionModel = options.visionModel
    this.textModel = options.textModel
    this.executionSite = options.executionSite ?? 'browser'
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000

    this.onStats = options.onStats
    this.contextTokens = options.contextTokens ?? 32_768
    this.maxOutputTokens = options.maxOutputTokens ?? 8_192
  }

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

      const body = (await response.json()) as {
        message?: { content?: string }
        prompt_eval_count?: number
        eval_count?: number
        prompt_eval_duration?: number
        eval_duration?: number
        total_duration?: number
        load_duration?: number
      }

      this.onStats?.({
        model,
        promptTokens: body.prompt_eval_count ?? 0,
        evalTokens: body.eval_count ?? 0,
        promptDurationNs: body.prompt_eval_duration ?? 0,
        evalDurationNs: body.eval_duration ?? 0,
        totalDurationNs: body.total_duration ?? 0,
        loadDurationNs: body.load_duration ?? 0,
      })

      const content = body.message?.content
      if (!content) throw new Error('Ollama returned an empty response.')

      const { value, truncated } = parseModelJson(content)
      if (truncated) {
        console.warn(
          `[ollama] reply truncated at ${content.length} chars — salvaged the complete entries`,
        )
      }

      return value
    } finally {
      clearTimeout(timer)
    }
  }

  async extractQuestions(page: PageInput): Promise<ExtractedQuestion[]> {
    const raw = await this.chat(
      this.visionModel,
      EXTRACTION_SYSTEM,
      extractionUserText(page, page.expect ?? []),
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

  async listModels(): Promise<string[]> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/tags`)
    if (!response.ok) throw new Error(`Ollama responded ${response.status}`)
    const body = (await response.json()) as { models?: { name: string }[] }
    return (body.models ?? []).map((model) => model.name)
  }
}
