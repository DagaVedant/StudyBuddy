import { z } from 'zod'

import { normalizeChoiceLabel } from '@/lib/questions/shape'

/**
 * Where a provider's work actually happens.
 *
 * `none` is the null provider, which is not a site at all: it answers nothing
 * and throws on every method. It used to claim `server`, which is a statement
 * that it runs here, and the one caller that needs to know otherwise had to
 * find out by matching `provider.name === 'null'`.
 */
export type ExecutionSite = 'server' | 'browser' | 'operator_gpu' | 'none'
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

/**
 * A worked solution, checked before anybody stores it as an answer.
 *
 * `answer` stays nullable all the way through. The prompt tells the model to
 * return null rather than guess, and a schema that quietly coerced that to a
 * string would throw away the one signal separating "I worked this out" from
 * "I picked the closest option".
 *
 * `confidence` runs through the same normaliser as the classifier's, because
 * models answer 0-100 however firmly the prompt says 0-1, and a 95 read as a
 * confidence of 95 clears every threshold ever written against it.
 */
export const solutionSchema = z.object({
  answer: z.string().max(400).nullable().default(null),
  working: z.string().max(8000).default(''),
  traps: z
    .array(
      z.object({
        label: z.string().max(8).nullable().default(null),
        why: z.string().max(600),
      }),
    )
    .max(12)
    .default([]),
  confidence: confidenceSchema.default(0),
})

export type Solution = z.infer<typeof solutionSchema>

export function parseSolution(raw: unknown): Solution {
  return solutionSchema.parse(raw)
}

/**
 * A topic lesson, checked the same way.
 *
 * The example count is clamped rather than required to be exactly two. A model
 * that returns three has still done the job, and rejecting the whole lesson
 * over the count would trade a good lesson for none.
 */
export const lessonSchema = z.object({
  body_md: z.string().min(1).max(20000),
  examples: z
    .array(
      z.object({
        question: z.string().max(2000),
        working: z.string().max(4000),
        answer: z.string().max(400),
      }),
    )
    .max(4)
    .default([]),
  common_errors: z
    .array(
      z.object({
        mistake: z.string().max(400),
        why: z.string().max(800),
        fix: z.string().max(800),
      }),
    )
    .max(8)
    .default([]),
})

export type Lesson = z.infer<typeof lessonSchema>

export function parseLesson(raw: unknown): Lesson {
  return lessonSchema.parse(raw)
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

  /**
   * The seam: the tail of the page before this one and the head of the page
   * after it, as text.
   *
   * Text only, and deliberately. The model is reading one page image at a time
   * and has no idea a question ran over the fold, which is the whole reason the
   * join and carried-options passes exist downstream. Sending the neighbouring
   * images too would double the cost of every extraction to help the one
   * question in twenty that is cut; the text layer is already in the worker's
   * hands and costs nothing to pass along.
   *
   * Optional because the first page has no before and the last has no after,
   * and because a scan with no text layer has neither.
   */
  before?: string
  after?: string
}

export interface TopicCandidate {
  slug: string
  name: string
  path: string
}

export interface AnswerInput {
  promptText: string
  choices: { label: string; text: string }[]
}

export interface LessonInput {
  topicName: string
  topicPath: string
  /**
   * A few real questions from this topic, so the lesson is pitched at the level
   * the student is actually being tested at rather than at the topic name.
   * "Circles" means something different on an AMC 8 paper and an SAT one.
   */
  samples: string[]
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
   * Works one question out, for a student checking their own paper.
   *
   * Required rather than optional, deliberately. An optional method here used
   * to mean every caller guessing whether a provider could do the job, and the
   * fix for that was `executionSite`: a provider that cannot answer says so by
   * being the null one, not by missing a method.
   */
  answerQuestion(input: AnswerInput): Promise<unknown>

  /** Teaches one topic. See {@link LessonInput}. */
  teachTopic(input: LessonInput): Promise<unknown>
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
  answerQuestion(input: AnswerInput): Promise<Solution>
  teachTopic(input: LessonInput): Promise<Lesson>
}

/**
 * A second opinion on whether extracted questions came out whole.
 *
 * Its own interface rather than an optional method on the two above, which is
 * the same fact stated in a way the type system can act on. As `reviewQuestions?`
 * it was a method every caller had to feature-detect at the call site, and every
 * provider that cannot review had to be understood as a provider with a hole in
 * it. There is nothing wrong with a provider that does not review; it is a
 * different capability, so it is a different interface.
 *
 * Worth doing only where a second model is already paid for and idle, which in
 * practice means the operator's GPU. Absence is "no opinion", never a failure.
 */
export interface RawQuestionReviewer {
  reviewQuestions(candidates: ReviewCandidate[]): Promise<unknown>
}

export interface QuestionReviewer {
  reviewQuestions(candidates: ReviewCandidate[]): Promise<QuestionReview[]>
}

/** Narrows to a provider that can also give a second opinion. */
export function canReview<T extends object>(
  provider: T,
): provider is T & QuestionReviewer {
  return typeof (provider as Partial<QuestionReviewer>).reviewQuestions === 'function'
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
