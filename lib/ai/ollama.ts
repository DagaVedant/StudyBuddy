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

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64')

  const CHUNK = 0x8000
  let binary = ''
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK))
  }

  return btoa(binary)
}

export interface OllamaCallStats {
  model: string
  promptTokens: number
  evalTokens: number
  promptDurationNs: number
  evalDurationNs: number
  totalDurationNs: number
  loadDurationNs: number
}

class EmptyReplyError extends Error {
  constructor(model: string) {
    super(`${model} returned an empty response.`)
    this.name = 'EmptyReplyError'
  }
}

const ANSWER_CONTEXT_TOKENS = 8_192

const LESSON_CONTEXT_TOKENS = 12_288

const TAGS_TIMEOUT_MS = 10_000

export interface OllamaOptions {
  baseUrl: string
  visionModel: string
  textModel: string

  executionSite?: ExecutionSite
  fetchImpl?: typeof fetch
  timeoutMs?: number

  answerModel?: string

  reviewModel?: string

  maxAttempts?: number

  contextTokens?: number
  maxOutputTokens?: number

  onStats?: (stats: OllamaCallStats) => void
}

export class OllamaProvider implements RawAIProvider, RawQuestionReviewer {
  readonly name = 'ollama' as const
  readonly supportsVision = true
  readonly executionSite: ExecutionSite

  readonly model: string

  readonly answeringModel: string

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
    this.answeringModel = this.answerModel
    this.reviewModel = options.reviewModel ?? options.textModel
    this.executionSite = options.executionSite ?? 'browser'
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000

    this.onStats = options.onStats
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
      [toBase64(page.image)],
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
    const image = input.image
    const model = image ? this.visionModel : this.answerModel

    return this.chat(
      model,
      ANSWER_SYSTEM,
      answerUserText(input),
      image ? [toBase64(image)] : undefined,
      ANSWER_JSON_SCHEMA as unknown as Record<string, unknown>,
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
    const response = await this.fetchImpl(`${this.baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(TAGS_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`Ollama responded ${response.status}`)
    const body = (await response.json()) as { models?: { name: string }[] }
    return (body.models ?? []).map((model) => model.name)
  }
}
