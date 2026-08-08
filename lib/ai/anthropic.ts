import Anthropic from '@anthropic-ai/sdk'

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
  ProviderRefused,
  type ExplainInput,
  type PageInput,
  type RawAIProvider,
  type TopicCandidate,
} from './types'

const DEFAULT_MODEL = 'claude-opus-5'

export class AnthropicProvider implements RawAIProvider {
  readonly name = 'anthropic' as const
  readonly supportsVision = true
  readonly executionSite = 'server' as const

  private readonly client: Anthropic
  private readonly model: string

  constructor(apiKey: string, model: string = DEFAULT_MODEL) {
    this.client = new Anthropic({ apiKey })
    this.model = model
  }

  private async complete(
    system: string,
    content: Anthropic.ContentBlockParam[],
    schema: Record<string, unknown>,
    maxTokens = 16000,
  ): Promise<unknown> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content }],
      output_config: {
        format: { type: 'json_schema', schema } as never,
      },
    })

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
