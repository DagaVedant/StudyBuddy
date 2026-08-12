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
  type AnswerInput,
  type ExplainInput,
  type LessonInput,
  type PageInput,
  type RawAIProvider,
  type TopicCandidate,
} from './types'
import { CLOUD_TIMEOUT_MS, upstreamFailure, upstreamUnreachable } from './upstream'

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

export class GeminiProvider implements RawAIProvider {
  readonly name = 'google' as const
  readonly supportsVision = true
  readonly executionSite = 'server' as const

  readonly model: string

  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch

  constructor(
    apiKey: string,
    model = 'gemini-2.5-flash',
    fetchImpl: typeof fetch = fetch,
  ) {
    this.apiKey = apiKey
    this.model = model
    this.fetchImpl = fetchImpl
  }

  private async generate(
    system: string,
    parts: unknown[],
    schema: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await this.fetchImpl(
      `${BASE}/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: 'POST',
        headers: {

          'x-goog-api-key': this.apiKey,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: geminiSchema(schema),
          },
        }),
      },
    ).catch((error) => {
      throw upstreamUnreachable('Gemini', error)
    })

    if (!response.ok) {
      // Logged rather than thrown. Google's error bodies carry the field path
      // that failed and, on a 400, a slice of the request that carried it.
      throw upstreamFailure('Gemini', response.status, await response.text())
    }

    const body = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[]
      promptFeedback?: { blockReason?: string }
    }

    const blocked = body.promptFeedback?.blockReason
    if (blocked) {
      throw new Error(`Gemini declined the page (${blocked}).`)
    }

    const text = body.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? '')
      .join('')

    if (!text) throw new Error('Gemini returned an empty response.')

    return parseModelJson(text).value
  }

  async extractQuestions(page: PageInput): Promise<unknown> {
    const raw = await this.generate(
      EXTRACTION_SYSTEM,
      [
        {
          inlineData: {
            mimeType: page.mediaType,
            data: Buffer.from(page.image).toString('base64'),
          },
        },
        { text: extractionUserText(page, page.expect ?? []) },
      ],
      EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown>,
    )

    return raw
  }

  async classifyTopic(
    promptText: string,
    candidates: TopicCandidate[],
  ): Promise<unknown> {
    const raw = await this.generate(
      CLASSIFY_SYSTEM,
      [{ text: classifyUserText(promptText, candidates) }],
      CLASSIFY_JSON_SCHEMA as unknown as Record<string, unknown>,
    )

    return raw
  }

  async answerQuestion(input: AnswerInput): Promise<unknown> {
    return this.generate(
      ANSWER_SYSTEM,
      [{ text: answerUserText(input) }],
      ANSWER_JSON_SCHEMA as unknown as Record<string, unknown>,
    )
  }

  async teachTopic(input: LessonInput): Promise<unknown> {
    return this.generate(
      LESSON_SYSTEM,
      [{ text: lessonUserText(input) }],
      LESSON_JSON_SCHEMA as unknown as Record<string, unknown>,
    )
  }

  async explain(input: ExplainInput): Promise<unknown> {
    const raw = await this.generate(
      EXPLAIN_SYSTEM,
      [{ text: explainUserText(input) }],
      EXPLAIN_JSON_SCHEMA as unknown as Record<string, unknown>,
    )

    return raw
  }
}

/**
 * The four shared schemas, in the dialect Gemini's `responseSchema` accepts.
 *
 * An allow-list, because Gemini rejects a schema outright for a keyword it does
 * not know rather than ignoring it, and the schemas here are written for the
 * OpenAI and Anthropic dialect which has several.
 *
 * `anyOf` is the one that cannot simply be dropped. Every nullable field in
 * every schema is written `anyOf: [{ type: 'T' }, { type: 'null' }]`, and
 * filtering that away left an empty object behind while the field stayed in
 * `required`. Gemini wants a `type` on every node, so a required property with
 * no type is a rejected request: `bbox`, `topic_slug`, `suggested_name`,
 * `misconception_note` and `reason` between them meant every Gemini call
 * failed, for extraction, classification and explanation alike. The provider
 * has never worked, and it is one of four offered in settings with a note
 * recommending its free tier.
 *
 * The allow-list already listed `nullable`, which is Gemini's own spelling of
 * the same idea. Nothing translated one into the other; this does.
 */
export function geminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set([
    'type',
    'format',
    'description',
    'nullable',
    'enum',
    'items',
    'properties',
    'required',
  ])

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk)
    if (node === null || typeof node !== 'object') return node

    const source = node as Record<string, unknown>

    // Before the filter, because the filter is what destroys it.
    if (Array.isArray(source.anyOf)) {
      const variants = source.anyOf as Record<string, unknown>[]
      const concrete = variants.filter((variant) => variant?.type !== 'null')

      // Only the "T or null" union, which is the only one these schemas use.
      // A genuine union of two concrete types has no Gemini equivalent, and
      // guessing one of the two would silently change what the model may
      // answer, so it is left to fail loudly upstream instead.
      if (concrete.length === 1 && concrete.length < variants.length) {
        return { ...(walk(concrete[0]) as object), nullable: true }
      }
    }

    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(source)) {
      if (!allowed.has(key)) continue
      out[key] = key === 'properties' ? mapValues(value, walk) : walk(value)
    }
    return out
  }

  return walk(schema) as Record<string, unknown>
}

function mapValues(value: unknown, fn: (input: unknown) => unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = fn(inner)
  }
  return out
}
