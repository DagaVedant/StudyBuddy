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

  private readonly client: Anthropic

  /**
   * `model` is required, and deliberately so.
   *
   * There used to be a default here as well as one in `DEFAULT_CLOUD_MODEL`,
   * and they disagreed. Every real call goes through `rawCloudProvider`, which
   * always passes a model, so the one here was reachable only from a test or a
   * script and would have quietly billed a different model than the settings
   * screen advertises. One default, in the table next to the other providers'.
   */
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
        // Explicit, because the SDK's own default is ten minutes and it scales
        // that up further for a large `max_tokens` on a non-streaming request.
        // Left alone, one wedged extraction outlives the route that started it.
        { timeout: CLOUD_TIMEOUT_MS },
      )
    } catch (error) {
      // The SDK puts the response body in `message`, and that message is
      // rendered on the student's status page. An authentication error arrives
      // as a JSON blob naming the header that was wrong.
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

    // Through the shared parser like every other provider. A schema-shaped
    // response is still a string the model wrote, so it carries the same
    // LaTeX escapes that quietly destroy a fraction.
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

  // Twice an explanation's budget: this returns a walkthrough, two worked
  // examples and the error list in one object.
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
