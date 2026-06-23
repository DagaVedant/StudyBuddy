import Anthropic from '@anthropic-ai/sdk'

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

const DEFAULT_MODEL = 'claude-opus-5'

/**
 * Tier B, Anthropic (spec §3.5). Runs server-side with the student's own key.
 *
 * Uses structured outputs rather than assistant prefills — prefills return a
 * 400 on current models. Note there is no `temperature` here: sampling
 * parameters are rejected on Opus 5.
 */
export class AnthropicProvider implements AIProvider {
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

    // Safety classifiers can decline; content is empty or partial when they do.
    if (response.stop_reason === 'refusal') {
      throw new ProviderRefused(response.stop_details?.category ?? null)
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')

    return JSON.parse(text)
  }

  async extractQuestions(page: PageInput): Promise<ExtractedQuestion[]> {
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
        { type: 'text', text: extractionUserText(page) },
      ],
      EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown>,
    )

    return parseExtraction(raw).questions
  }

  async classifyTopic(
    promptText: string,
    candidates: TopicCandidate[],
  ): Promise<Classification> {
    const raw = await this.complete(
      CLASSIFY_SYSTEM,
      [{ type: 'text', text: classifyUserText(promptText, candidates) }],
      CLASSIFY_JSON_SCHEMA as unknown as Record<string, unknown>,
      2000,
    )

    return classificationSchema.parse(raw)
  }

  async explain(input: ExplainInput): Promise<Explanation> {
    const raw = await this.complete(
      EXPLAIN_SYSTEM,
      [{ type: 'text', text: explainUserText(input) }],
      EXPLAIN_JSON_SCHEMA as unknown as Record<string, unknown>,
      4000,
    )

    return explanationSchema.parse(raw)
  }
}
