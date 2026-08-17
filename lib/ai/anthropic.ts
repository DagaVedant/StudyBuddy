import Anthropic from '@anthropic-ai/sdk'

import { parseModelJson } from './json'
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
} from './prompts'
import {
  ProviderRefused,
  type AnswerInput,
  type ExplainInput,
  type LessonInput,
  type PageInput,
  type RawAIProvider,
  type TopicCandidate,
} from './types'
import { CLOUD_TIMEOUT_MS, upstreamFailure, upstreamUnreachable } from './upstream'

export class AnthropicProvider implements RawAIProvider {
  readonly name = 'anthropic' as const
  readonly supportsVision = true
  readonly executionSite = 'server' as const

  readonly model: string

  get answeringModel(): string {
    return this.model
  }

  private readonly client: Anthropic

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey })
    this.model = model
  }

  private async complete(
    system: string,
    content: Anthropic.ContentBlockParam[],
    schema: Record<string, unknown>,
    maxTokens = 16000,
  ): Promise<unknown> {
    let response: Anthropic.Message
    try {
      response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content }],
          output_config: {
            format: { type: 'json_schema', schema } as never,
          },
        },
        { timeout: CLOUD_TIMEOUT_MS },
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

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')

    return parseModelJson(text).value
  }

  async extractQuestions(page: PageInput): Promise<unknown> {
    const raw = await this.complete(
      EXTRACTION_SYSTEM,
      [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: page.mediaType as 'image/webp',
            data: Buffer.from(page.image).toString('base64'),
          },
        },
        { type: 'text', text: extractionUserText(page, page.expect ?? []) },
      ],
      EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown>,
    )

    return raw
  }

  async classifyTopic(
    promptText: string,
    candidates: TopicCandidate[],
  ): Promise<unknown> {
    const raw = await this.complete(
      CLASSIFY_SYSTEM,
      [{ type: 'text', text: classifyUserText(promptText, candidates) }],
      CLASSIFY_JSON_SCHEMA as unknown as Record<string, unknown>,
      2000,
    )

    return raw
  }

  async answerQuestion(input: AnswerInput): Promise<unknown> {
    return this.complete(
      ANSWER_SYSTEM,
      [{ type: 'text', text: answerUserText(input) }],
      ANSWER_JSON_SCHEMA as unknown as Record<string, unknown>,
      4000,
    )
  }

  async teachTopic(input: LessonInput): Promise<unknown> {
    return this.complete(
      LESSON_SYSTEM,
      [{ type: 'text', text: lessonUserText(input) }],
      LESSON_JSON_SCHEMA as unknown as Record<string, unknown>,
      8000,
    )
  }

  async explain(input: ExplainInput): Promise<unknown> {
    const raw = await this.complete(
      EXPLAIN_SYSTEM,
      [{ type: 'text', text: explainUserText(input) }],
      EXPLAIN_JSON_SCHEMA as unknown as Record<string, unknown>,
      4000,
    )

    return raw
  }
}
