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
        /**
         * Bounded generously and narrowed by the transform, not before it.
         *
         * `normalizeChoiceLabel` exists precisely because the extractor often
         * returns the whole option here (`A. 60` rather than `A`), and it
         * already clamps its own result to 8 characters. Applying `.max(8)` to
         * the raw string ran the check against the input the transform was
         * written to repair, so an option too long to be a label was thrown
         * away instead of being reduced to one.
         *
         * That is not hypothetical: on a coordinate-geometry paper every
         * choice reads `A. (-2, 3)`, which is ten characters, so six of the
         * seven questions on a page were rejected and the paper reported 8 of
         * its 15 questions. The count-only warning made it look like a model
         * failure for two days.
         */
        label: z.string().min(1).max(2000).transform(normalizeChoiceLabel),
        text: z.string().max(2000),
      }),
    )
    .max(12)
    .default([]),

  /**
   * Four numbers, or nothing, and never a reason to lose the question.
   *
   * A tuple on its own made the length load-bearing: a model that returned
   * five numbers, or two, or `[x, y, "12"]`, failed this field and took the
   * whole question with it, silently, because a rejected question is only a
   * line in a warning. That is the wrong trade in both directions. The bbox is
   * optional metadata, used to crop the page image on the verify screen and
   * for nothing else, and a question added by hand carries `null` here
   * already, so null is a shape the rest of the app has always handled. The
   * prompt text is the thing the student actually needs.
   *
   * So a malformed box costs the box. The wire schema cannot express the
   * length (see EXTRACTION_JSON_SCHEMA), which is exactly why this has to.
   */
  bbox: z
    .preprocess(
      (value) => (isBox(value) ? value : null),
      z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
    )
    .default(null),
  has_figure: z.boolean().default(false),
})

function isBox(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    // Finite, not merely numeric: Infinity survives `z.number()` and then
    // crops to a box with no bottom edge.
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  )
}

export const extractionResultSchema = z.object({
  questions: z.array(extractedQuestionSchema).max(100),
})

export type ExtractedQuestion = z.infer<typeof extractedQuestionSchema>

/**
 * Why one question was thrown away, in enough detail to act on.
 *
 * A count alone is not actionable: "dropped 6 unreadable question(s)" was the
 * only trace a page losing six of its seven questions ever left, and it does
 * not say whether the model returned nonsense or whether this schema is
 * stricter than the paper.
 */
export interface ExtractionRejection {
  /** The failing field, e.g. `bbox` or `choices.1.label`. */
  path: string
  message: string
  /** Enough of the question to find it on the page. */
  preview: string
}

function previewOf(item: unknown): string {
  const text = (item as { prompt_text?: unknown })?.prompt_text
  const source = typeof text === 'string' && text.length > 0 ? text : JSON.stringify(item)
  return (source ?? '').replace(/\s+/g, ' ').slice(0, 70)
}

export function parseExtraction(raw: unknown): {
  questions: ExtractedQuestion[]
  rejected: number
  rejections: ExtractionRejection[]
} {
  const outer = z
    .object({ questions: z.array(z.unknown()).max(200) })
    .safeParse(raw)

  if (!outer.success) return { questions: [], rejected: 0, rejections: [] }

  const questions: ExtractedQuestion[] = []
  const rejections: ExtractionRejection[] = []

  for (const item of outer.data.questions) {
    const parsed = extractedQuestionSchema.safeParse(item)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      rejections.push({
        path: issue?.path.join('.') || '(root)',
        message: issue?.message ?? 'invalid',
        preview: previewOf(item),
      })
      continue
    }

    if (isRestatement(parsed.data.prompt_text)) {
      rejections.push({
        path: 'prompt_text',
        message: 'reads as a restatement of the task rather than a question',
        preview: previewOf(item),
      })
      continue
    }

    questions.push(parsed.data)
  }

  return { questions, rejected: rejections.length, rejections }
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

  /**
   * The model that writes the text this provider returns.
   *
   * `name` says who was asked; this says what answered, and the two are not
   * interchangeable. `explanations.model` was being filled with `provider.name`
   * for want of anything better, so every row generated through a key said
   * `anthropic` and no row anywhere recorded which model produced it. That is
   * the column you need on the day an explanation comes out wrong and the
   * question is whether the model changed underneath you.
   *
   * Ollama runs a different model per task; this is its text model, which is
   * the one that writes explanations. Nothing records the model behind an
   * extraction yet, because nothing stores a row per extraction to record it
   * on.
   */
  readonly model: string

  readonly supportsVision: boolean
  readonly executionSite: ExecutionSite
}

/**
 * What a model actually hands back: its own JSON, decoded but not checked.
 *
 * Every method returns `unknown` on purpose. The old contract had providers
 * return `ExtractedQuestion[]` (the *output* type of the zod schema) so the
 * signature read as "already validated" while nothing enforced it. Four of the
 * five providers happened to validate inside themselves and one did not, and
 * the type system had no opinion either way. That is how options reached the
 * database labelled `A. 60` instead of `A`, which silently switched off the
 * lead-in fold, the duplicate merge, and the answer key.
 *
 * A provider implements this. Nobody consumes it directly; {@link validated}
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
   * paid for and idle: the operator's GPU. Callers must treat its absence as
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
