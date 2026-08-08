import { z } from 'zod'

import { normalizeChoiceLabel } from '@/lib/questions/shape'

export type ExecutionSite = 'server' | 'browser' | 'operator_gpu'
export type ProviderName =
  | 'anthropic'
  | 'openai'
  | 'openrouter'
  | 'google'
  | 'ollama'
  | 'operator_gpu'
  | 'mock'
  | 'null'

export const questionTypeSchema = z.enum([
  'multiple_choice',
  'free_response',
  'true_false',
  'fill_blank',
  'grid_in',
])

export const extractedQuestionSchema = z.object({

  ordinal: z.coerce
    .number()
    .catch(0)
    .transform((value) => (Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0)),
  prompt_text: z.string().min(1).max(8000),
  question_type: questionTypeSchema,
  choices: z
    .array(
      z.object({

        label: z.string().min(1).max(8).transform(normalizeChoiceLabel),
        text: z.string().max(2000),
      }),
    )
    .max(12)
    .default([]),

  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable().default(null),
  has_figure: z.boolean().default(false),
})

export const extractionResultSchema = z.object({
  questions: z.array(extractedQuestionSchema).max(100),
})

export type ExtractedQuestion = z.infer<typeof extractedQuestionSchema>

export function parseExtraction(raw: unknown): {
  questions: ExtractedQuestion[]
  rejected: number
} {
  const outer = z
    .object({ questions: z.array(z.unknown()).max(200) })
    .safeParse(raw)

  if (!outer.success) return { questions: [], rejected: 0 }

  const questions: ExtractedQuestion[] = []
  let rejected = 0

  for (const item of outer.data.questions) {
    const parsed = extractedQuestionSchema.safeParse(item)
    if (!parsed.success) {
      rejected += 1
      continue
    }

    if (isRestatement(parsed.data.prompt_text)) {
      rejected += 1
      continue
    }

    questions.push(parsed.data)
  }

  return { questions, rejected }
}

const RESTATEMENT = /^\s*(the\s+)?question\s+(asks|is\s+asking|requires|wants)\b/i

function isRestatement(promptText: string): boolean {
  return RESTATEMENT.test(promptText)
}

const confidenceSchema = z.preprocess((value) => {
  const raw = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(raw)) return 0
  const normalized = raw > 1 ? raw / 100 : raw
  return Math.min(Math.max(normalized, 0), 1)
}, z.number().min(0).max(1))

export const classificationSchema = z.object({

  topic_slug: z.string().nullable(),
  confidence: confidenceSchema.default(0),
  abstain: z.boolean().default(false),

  suggested_name: z.string().max(120).nullable().default(null),
})

export type Classification = z.infer<typeof classificationSchema>

export function parseClassification(raw: unknown): Classification {
  return classificationSchema.parse(raw)
}

export const explanationSchema = z.object({
  body_md: z.string().min(1).max(6000),

  misconception_note: z.string().max(400).nullable().default(null),
})

export type Explanation = z.infer<typeof explanationSchema>

export function parseExplanation(raw: unknown): Explanation {
  return explanationSchema.parse(raw)
}

export interface ReviewCandidate {
  /** The number printed on the page, which is how the verdict points back. */
  number: number
  prompt_text: string
  choices: { label: string; text: string }[]
}

export const questionReviewSchema = z.object({
  number: z.coerce
    .number()
    .catch(0)
    .transform((value) => (Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0)),
  intact: z.boolean(),
  reason: z.string().max(400).nullable().default(null),
})

export const reviewResultSchema = z.object({
  verdicts: z.array(questionReviewSchema).max(100).default([]),
})

export type QuestionReview = z.infer<typeof questionReviewSchema>

/**
 * A review reply, or no opinion.
 *
 * A malformed review means no opinion, not a failed worksheet: it runs after
 * the questions are already saved, so refusing to parse should cost the student
 * a second look, never the upload.
 */
export function parseReview(raw: unknown): QuestionReview[] {
  const parsed = reviewResultSchema.safeParse(raw)

  if (!parsed.success) {
    console.warn('[ai] could not read the review reply, treating as no opinion')
    return []
  }

  return parsed.data.verdicts
}

export interface PageInput {

  image: Uint8Array
  mediaType: string

  text: string
  width: number
  height: number
  pageNumber: number

  expect?: number[]
}

export interface TopicCandidate {
  slug: string
  name: string
  path: string
}

export interface ExplainInput {
  promptText: string
  choices: { label: string; text: string }[]
  correctAnswer: string | null

  studentAnswer: string | null
}

interface ProviderIdentity {
  readonly name: ProviderName
  readonly supportsVision: boolean
  readonly executionSite: ExecutionSite
}

/**
 * What a model actually hands back: its own JSON, decoded but not checked.
 *
 * Every method returns `unknown` on purpose. The old contract had providers
 * return `ExtractedQuestion[]` — the *output* type of the zod schema — so the
 * signature read as "already validated" while nothing enforced it. Four of the
 * five providers happened to validate inside themselves and one did not, and
 * the type system had no opinion either way. That is how options reached the
 * database labelled `A. 60` instead of `A`, which silently switched off the
 * lead-in fold, the duplicate merge, and the answer key.
 *
 * A provider implements this. Nobody consumes it directly — {@link validated}
 * turns it into an {@link AIProvider}, and that is what callers hold.
 */
export interface RawAIProvider extends ProviderIdentity {
  extractQuestions(page: PageInput): Promise<unknown>
  classifyTopic(promptText: string, candidates: TopicCandidate[]): Promise<unknown>
  explain(input: ExplainInput): Promise<unknown>

  /**
   * A second opinion on whether extracted questions came out whole.
   *
   * Optional because it is worth doing only where a second model is already
   * paid for and idle — the operator's GPU. Callers must treat its absence as
   * "no opinion" rather than as a failure, and a provider that cannot do it is
   * not a worse provider.
   */
  reviewQuestions?(candidates: ReviewCandidate[]): Promise<unknown>
}

/**
 * The same provider with everything it returns already checked.
 *
 * The only shape callers should ever hold. Obtained from {@link validated}, so
 * a value of this type has been through the schemas by construction rather
 * than by the good manners of whoever wrote the provider.
 */
export interface AIProvider extends ProviderIdentity {
  extractQuestions(page: PageInput): Promise<ExtractedQuestion[]>
  classifyTopic(promptText: string, candidates: TopicCandidate[]): Promise<Classification>
  explain(input: ExplainInput): Promise<Explanation>
  reviewQuestions?(candidates: ReviewCandidate[]): Promise<QuestionReview[]>
}

export class ProviderUnavailable extends Error {
  constructor(message = 'No AI provider is configured for this account.') {
    super(message)
    this.name = 'ProviderUnavailable'
  }
}

export class ProviderRefused extends Error {
  constructor(public readonly category: string | null) {
    super('The model declined this request.')
    this.name = 'ProviderRefused'
  }
}
