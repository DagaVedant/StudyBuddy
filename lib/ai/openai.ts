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
  extractionResultSchema,
  type AIProvider,
  type Classification,
  type ExplainInput,
  type ExtractedQuestion,
  type Explanation,
  type PageInput,
  type TopicCandidate,
} from './types'

/**
 * Tier B, OpenAI. Uses the Chat Completions API over plain fetch rather than
 * pulling in a second vendor SDK for three calls.
 */
export class OpenAIProvider implements AIProvider {
  readonly name = 'openai' as const
  readonly supportsVision = true
  readonly executionSite = 'server' as const

  private readonly apiKey: string
  private readonly model: string
  private readonly fetchImpl: typeof fetch

  constructor(apiKey: string, model = 'gpt-4.1', fetchImpl: typeof fetch = fetch) {
    this.apiKey = apiKey
    this.model = model
    this.fetchImpl = fetchImpl
  }

  private async chat(
    system: string,
    content: unknown,
    schemaName: string,
    schema: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await this.fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: schemaName, strict: true, schema },
        },
      }),
    })

    if (!response.ok) {
      throw new Error(`OpenAI responded ${response.status}: ${await response.text()}`)
    }

    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[]
    }

    const text = body.choices?.[0]?.message?.content
    if (!text) throw new Error('OpenAI returned an empty response.')

    return JSON.parse(text)
  }

  async extractQuestions(page: PageInput): Promise<ExtractedQuestion[]> {
    const dataUrl = `data:${page.mediaType};base64,${Buffer.from(page.image).toString('base64')}`

    const raw = await this.chat(
      EXTRACTION_SYSTEM,
      [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: extractionUserText(page) },
      ],
      'extraction',
      EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown>,
    )

    return extractionResultSchema.parse(raw).questions
  }

  async classifyTopic(
    promptText: string,
    candidates: TopicCandidate[],
  ): Promise<Classification> {
    const raw = await this.chat(
      CLASSIFY_SYSTEM,
      classifyUserText(promptText, candidates),
      'classification',
      CLASSIFY_JSON_SCHEMA as unknown as Record<string, unknown>,
    )

    return classificationSchema.parse(raw)
  }

  async explain(input: ExplainInput): Promise<Explanation> {
    const raw = await this.chat(
      EXPLAIN_SYSTEM,
      explainUserText(input),
      'explanation',
      EXPLAIN_JSON_SCHEMA as unknown as Record<string, unknown>,
    )

    return explanationSchema.parse(raw)
  }
}
