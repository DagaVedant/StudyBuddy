import {and, eq} from 'drizzle-orm'

import {type Db} from '@/lib/db'
import {userAiCredentials} from '@/lib/schema'

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
  REVIEW_JSON_SCHEMA,
  REVIEW_SYSTEM,
  reviewUserText,
} from './prompts'
import {
  type AnswerInput,
  type ExecutionSite,
  type ExplainInput,
  type LessonInput,
  type PageInput,
  parseModelJson,
  type PracticeInput,
  type RawAIProvider,
  type RawQuestionReviewer,
  type ReviewCandidate,
  type TopicCandidate,
} from './types'

// the browser tier runs this in a page, where Buffer does not exist
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
  answerModel?: string
  reviewModel?: string

  executionSite?: ExecutionSite
  fetchImpl?: typeof fetch
  timeoutMs?: number
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
  private readonly reviewModel: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly contextTokens: number
  private readonly maxOutputTokens: number
  private readonly maxAttempts: number
  private readonly onStats?: (stats: OllamaCallStats) => void

  constructor(options: OllamaOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.model = options.textModel
    this.answeringModel = options.answerModel ?? options.textModel
    this.visionModel = options.visionModel
    this.reviewModel = options.reviewModel ?? options.textModel
    this.executionSite = options.executionSite ?? 'browser'
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000
    this.contextTokens = options.contextTokens ?? 24_576
    this.maxOutputTokens = options.maxOutputTokens ?? 8_192
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3)
    this.onStats = options.onStats
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
        headers: {'Content-Type': 'application/json'},
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
            {role: 'system', content: system},
            images?.length
              ? {role: 'user', content: userText, images}
              : {role: 'user', content: userText},
          ],
        }),
      })

      if (!response.ok) {
        throw new Error(
          `Ollama responded ${response.status}. Is it running, and is ${model} pulled?`,
        )
      }

      const body = (await response.json()) as {
        message?: {content?: string}
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

      const {value, truncated} = parseModelJson(content)
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
    return this.chat(
      this.visionModel,
      EXTRACTION_SYSTEM,
      extractionUserText(page, page.expect ?? []),
      [toBase64(page.image)],
      EXTRACTION_JSON_SCHEMA,
    )
  }

  async classifyTopic(
    promptText: string,
    candidates: TopicCandidate[],
  ): Promise<unknown> {
    return this.chat(
      this.model,
      CLASSIFY_SYSTEM,
      classifyUserText(promptText, candidates),
      undefined,
      CLASSIFY_JSON_SCHEMA,
    )
  }

  async answerQuestion(input: AnswerInput): Promise<unknown> {
    const image = input.image

    return this.chat(
      image ? this.visionModel : this.answeringModel,
      ANSWER_SYSTEM,
      answerUserText(input),
      image ? [toBase64(image)] : undefined,
      ANSWER_JSON_SCHEMA,
      image ? this.contextTokens : ANSWER_CONTEXT_TOKENS,
    )
  }

  async teachTopic(input: LessonInput): Promise<unknown> {
    return this.chat(
      this.answeringModel,
      LESSON_SYSTEM,
      lessonUserText(input),
      undefined,
      LESSON_JSON_SCHEMA,
      LESSON_CONTEXT_TOKENS,
    )
  }

  async writePractice(input: PracticeInput): Promise<unknown> {
    return this.chat(
      this.answeringModel,
      PRACTICE_SYSTEM,
      practiceUserText(input),
      undefined,
      PRACTICE_JSON_SCHEMA,
      LESSON_CONTEXT_TOKENS,
    )
  }

  async explain(input: ExplainInput): Promise<unknown> {
    return this.chat(
      this.model,
      EXPLAIN_SYSTEM,
      explainUserText(input),
      undefined,
      EXPLAIN_JSON_SCHEMA,
    )
  }

  async reviewQuestions(candidates: ReviewCandidate[]): Promise<unknown> {
    if (candidates.length === 0) return {verdicts: []}

    return this.chat(
      this.reviewModel,
      REVIEW_SYSTEM,
      reviewUserText(candidates),
      undefined,
      REVIEW_JSON_SCHEMA,
    )
  }

  async listModels(): Promise<string[]> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(TAGS_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`Ollama responded ${response.status}`)
    const body = (await response.json()) as {models?: {name: string}[]}
    return (body.models ?? []).map((model) => model.name)
  }
}

export const OLLAMA_FALLBACK_MODEL = 'qwen2.5vl:7b'

export interface OllamaConfig {
  baseUrl: string
  visionModel: string
  textModel: string
}

export async function ollamaConfig(
  db: Db,
  userId: string,
): Promise<OllamaConfig | null> {
  const [credential] = await db
    .select({
      baseUrl: userAiCredentials.ollamaBaseUrl,
      visionModel: userAiCredentials.visionModelName,
      textModel: userAiCredentials.modelName,
    })
    .from(userAiCredentials)
    .where(
      and(eq(userAiCredentials.userId, userId), eq(userAiCredentials.provider, 'ollama')),
    )
    .limit(1)

  if (!credential?.baseUrl) return null

  return {
    baseUrl: credential.baseUrl,
    visionModel: credential.visionModel ?? OLLAMA_FALLBACK_MODEL,
    textModel: credential.textModel ?? OLLAMA_FALLBACK_MODEL,
  }
}
