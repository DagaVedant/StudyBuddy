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
  REVIEW_JSON_SCHEMA,
  REVIEW_SYSTEM,
  reviewUserText,
} from './prompts'
import { parseModelJson } from './json'
import {
  type ExecutionSite,
  type AnswerInput,
  type ExplainInput,
  type LessonInput,
  type PageInput,
  type RawAIProvider,
  type RawQuestionReviewer,
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
  /** Time spent bringing the model into memory; large when it is offloaded. */
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

/**
 * One question, its options, and room for a reasoning model to think.
 *
 * The longest stored question is a few hundred tokens and the system prompt is
 * under one thousand, so 8k leaves the whole budget to the working. Reasoning
 * models spend the output allowance thinking, which is why this is not smaller.
 */
const ANSWER_CONTEXT_TOKENS = 8_192

/** A lesson carries five sample questions in and a long answer out. */
const LESSON_CONTEXT_TOKENS = 12_288

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
   * than reading the page was, so a small fast model is the right tool. This
   * runs over every question on the worksheet.
   */
  /**
   * Model used to work a question out and to teach a topic, defaulting to
   * textModel.
   *
   * Its own setting because solving is not the job the other two models were
   * chosen for. The vision model was picked by measurement on reading a page,
   * and the review model on judging whether a question came out whole; neither
   * contest says anything about whether a model can do the maths. A derived
   * answer is stored as the answer and shown to a student, so this is the one
   * place where being slower and larger is worth it.
   */
  answerModel?: string

  reviewModel?: string

  /**
   * How many times to ask before giving up on a page.
   *
   * Benchmarking found empty replies on roughly a quarter of pages for some
   * models, and each one silently costs every question on that page; the
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

export class OllamaProvider implements RawAIProvider, RawQuestionReviewer {
  readonly name = 'ollama' as const
  readonly supportsVision = true
  readonly executionSite: ExecutionSite

  /**
   * The text model, since that is the one whose output gets recorded.
   *
   * Ollama is the only provider that runs more than one, and there is no
   * single answer here that is right for both jobs. The one caller that reads
   * this is storing an explanation, which the text model wrote.
   */
  readonly model: string

  private readonly baseUrl: string
  private readonly visionModel: string
  private readonly textModel: string
  private readonly answerModel: string
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
    this.model = options.textModel
    this.answerModel = options.answerModel ?? options.textModel
    this.reviewModel = options.reviewModel ?? options.textModel
    this.executionSite = options.executionSite ?? 'browser'
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000

    this.onStats = options.onStats
    // 24576, not 32768: every request in flight reserves its own KV cache, so
    // the reservation is what decides whether a second page can be read at the
    // same time or whether the model spills out of VRAM and collapses to a
    // tenth of its speed.
    //
    // Not lower, though. The densest page measured wanted 10,182 prompt tokens
    // and hit the 8,192 output cap, so ~18.4k is the real worst case rather
    // than the ~3.9k average; sizing this off the average would quietly
    // truncate exactly the pages that carry the most questions.
    this.contextTokens = options.contextTokens ?? 24_576
    this.maxOutputTokens = options.maxOutputTokens ?? 8_192
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3)
  }

  private async chat(
    model: string,
    system: string,
    userText: string,
    images: string[] | undefined,
    schema: Record<string, unknown>,
    /**
     * Context to reserve, when the caller knows it needs far less than a page.
     *
     * The default is sized for the densest page measured, which is the right
     * size for reading one and five times too big for solving one. Every
     * request reserves its own KV cache, so a 24k reservation for a question
     * that fits in one is not merely wasteful: on a 16GB card it is the
     * difference between the model sitting in VRAM and spilling out of it.
     * Measured on the backfill, where the same model that answered a benchmark
     * question in five seconds was taking twenty-five.
     */
    contextTokens = this.contextTokens,
  ): Promise<unknown> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.chatOnce(
          model,
          system,
          userText,
          images,
          schema,
          attempt,
          contextTokens,
        )
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
    contextTokens: number,
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

            num_ctx: contextTokens,
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
          `[ollama] reply truncated at ${content.length} chars; salvaged the complete entries`,
        )
      }

      return value
    } finally {
      clearTimeout(timer)
    }
  }

  async extractQuestions(page: PageInput): Promise<unknown> {
    const raw = await this.chat(
      this.visionModel,
      EXTRACTION_SYSTEM,
      extractionUserText(page, page.expect ?? []),
      [Buffer.from(page.image).toString('base64')],
      EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown>,
    )

    return raw
  }

  async classifyTopic(
    promptText: string,
    candidates: TopicCandidate[],
  ): Promise<unknown> {
    const raw = await this.chat(
      this.textModel,
      CLASSIFY_SYSTEM,
      classifyUserText(promptText, candidates),
      undefined,
      CLASSIFY_JSON_SCHEMA as unknown as Record<string, unknown>,
    )

    return raw
  }

  async answerQuestion(input: AnswerInput): Promise<unknown> {
    /*
     * The vision model when there is a page to look at, the answer model when
     * there is not.
     *
     * Not a preference. The answer model is chosen for reasoning and is text
     * only, so handing it an image is not a worse answer, it is an error. The
     * two are different models on purpose and this is the one place the
     * distinction has to be made at call time rather than at construction.
     */
    const image = input.image
    const model = image ? this.visionModel : this.answerModel

    return this.chat(
      model,
      ANSWER_SYSTEM,
      answerUserText(input),
      image ? [Buffer.from(image).toString('base64')] : undefined,
      ANSWER_JSON_SCHEMA as unknown as Record<string, unknown>,
      // A page image is worth several thousand tokens on its own.
      image ? this.contextTokens : ANSWER_CONTEXT_TOKENS,
    )
  }

  async teachTopic(input: LessonInput): Promise<unknown> {
    return this.chat(
      this.answerModel,
      LESSON_SYSTEM,
      lessonUserText(input),
      undefined,
      LESSON_JSON_SCHEMA as unknown as Record<string, unknown>,
      LESSON_CONTEXT_TOKENS,
    )
  }

  async explain(input: ExplainInput): Promise<unknown> {
    const raw = await this.chat(
      this.textModel,
      EXPLAIN_SYSTEM,
      explainUserText(input),
      undefined,
      EXPLAIN_JSON_SCHEMA as unknown as Record<string, unknown>,
    )

    return raw
  }

  async reviewQuestions(candidates: ReviewCandidate[]): Promise<unknown> {
    if (candidates.length === 0) return { verdicts: [] }

    const raw = await this.chat(
      this.reviewModel,
      REVIEW_SYSTEM,
      reviewUserText(candidates),
      undefined,
      REVIEW_JSON_SCHEMA as unknown as Record<string, unknown>,
    )

    return raw
  }

  async listModels(): Promise<string[]> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/tags`)
    if (!response.ok) throw new Error(`Ollama responded ${response.status}`)
    const body = (await response.json()) as { models?: { name: string }[] }
    return (body.models ?? []).map((model) => model.name)
  }
}
