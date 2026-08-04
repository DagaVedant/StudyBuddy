import {
  CLASSIFY_JSON_SCHEMA,
  CLASSIFY_SYSTEM,
  EXPLAIN_JSON_SCHEMA,
  EXPLAIN_SYSTEM,
  EXTRACTION_JSON_SCHEMA,
  EXTRACTION_SYSTEM,
  REVIEW_JSON_SCHEMA,
  REVIEW_SYSTEM,
  classifyUserText,
  explainUserText,
  extractionUserText,
  reviewUserText,
} from './prompts'
import { parseModelJson } from './json'
import {
  classificationSchema,
  explanationSchema,
  parseExtraction,
  reviewResultSchema,
  type AIProvider,
  type Classification,
  type ExecutionSite,
  type ExplainInput,
  type ExtractedQuestion,
  type Explanation,
  type PageInput,
  type QuestionReview,
  type ReviewCandidate,
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

/**
 * The model accepted the request and then generated nothing.
 *
 * Distinct from a transport failure: the call succeeded, so no HTTP status
 * reports it, and distinct from a page that genuinely holds no questions,
 * because those come back as a valid empty list rather than empty content.
 */
class EmptyReplyError extends Error {
  constructor(model: string) {
    super(`${model} returned an empty response.`)
    this.name = 'EmptyReplyError'
  }
}

export interface OllamaOptions {
  baseUrl: string
  visionModel: string
  textModel: string

  executionSite?: ExecutionSite
  fetchImpl?: typeof fetch
  timeoutMs?: number

  /**
   * Model used to sanity-check extracted questions, defaulting to textModel.
   *
   * Its job is judging whether a question came out whole, which is far easier
   * than reading the page was, so a small fast model is the right tool — this
   * runs over every question on the worksheet.
   */
  reviewModel?: string

  /**
   * How many times to ask before giving up on a page.
   *
   * Benchmarking found empty replies on roughly a quarter of pages for some
   * models, and each one silently costs every question on that page — the
   * audit only sees gaps in the printed numbering it was given, so a page
   * that returns nothing at all leaves nothing behind to notice. One retry
   * recovered every such page in the sample.
   */
  maxAttempts?: number

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
  private readonly reviewModel: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly contextTokens: number
  private readonly maxOutputTokens: number
  private readonly maxAttempts: number
  private readonly onStats?: (stats: OllamaCallStats) => void

  constructor(options: OllamaOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.visionModel = options.visionModel
    this.textModel = options.textModel
    this.reviewModel = options.reviewModel ?? options.textModel
    this.executionSite = options.executionSite ?? 'browser'
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000

    this.onStats = options.onStats
    this.contextTokens = options.contextTokens ?? 32_768
    this.maxOutputTokens = options.maxOutputTokens ?? 8_192
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3)
  }

  private async chat(
    model: string,
    system: string,
    userText: string,
    images: string[] | undefined,
    schema: Record<string, unknown>,
  ): Promise<unknown> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.chatOnce(model, system, userText, images, schema, attempt)
      } catch (error) {
        if (!(error instanceof EmptyReplyError) || attempt >= this.maxAttempts) throw error

        console.warn(
          `[ollama] ${model} generated nothing on attempt ${attempt}, asking again`,
        )
      }
    }
  }

  private async chatOnce(
    model: string,
    system: string,
    userText: string,
    images: string[] | undefined,
    schema: Record<string, unknown>,
    attempt: number,
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
            // Greedy first, since that is the most faithful transcription.
            // A repeat means the model already chose to emit nothing here, so
            // asking again identically would land on the same silence; a small
            // amount of randomness is what lets the retry take another path.
            temperature: attempt === 1 ? 0 : 0.2 * (attempt - 1),

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
      if (!content?.trim()) throw new EmptyReplyError(model)

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

  async reviewQuestions(candidates: ReviewCandidate[]): Promise<QuestionReview[]> {
    if (candidates.length === 0) return []

    const raw = await this.chat(
      this.reviewModel,
      REVIEW_SYSTEM,
      reviewUserText(candidates),
      undefined,
      REVIEW_JSON_SCHEMA as unknown as Record<string, unknown>,
    )

    // A malformed review means no opinion, not a failed worksheet. This runs
    // after the questions are already saved, so refusing to parse should cost
    // the student a second look, never the upload.
    const parsed = reviewResultSchema.safeParse(raw)
    if (!parsed.success) {
      console.warn('[ollama] could not read the review reply, treating as no opinion')
      return []
    }

    return parsed.data.verdicts
  }

  async listModels(): Promise<string[]> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/tags`)
    if (!response.ok) throw new Error(`Ollama responded ${response.status}`)
    const body = (await response.json()) as { models?: { name: string }[] }
    return (body.models ?? []).map((model) => model.name)
  }
}
