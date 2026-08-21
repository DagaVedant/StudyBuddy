import { z } from 'zod'

import { normalizeChoiceLabel } from '@/lib/questions/shape'

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
        label: z.string().min(1).max(2000).transform(normalizeChoiceLabel),
        text: z.string().max(2000),
      }),
    )
    .max(12)
    .default([]),

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
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  )
}

export const extractionResultSchema = z.object({
  questions: z.array(extractedQuestionSchema).max(100),
})

export type ExtractedQuestion = z.infer<typeof extractedQuestionSchema>

export interface ExtractionRejection {
  path: string
  message: string
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
        why: z.string().max(2000),
        fix: z.string().max(2000),
      }),
    )
    .max(8)
    .default([]),
})

export type Lesson = z.infer<typeof lessonSchema>

export function parseLesson(raw: unknown): Lesson {
  return lessonSchema.parse(raw)
}

export const generatedQuestionSchema = z.object({
  prompt_text: z.string().trim().min(1).max(4000),
  choices: z
    .array(
      z.object({
        label: z.string().min(1).max(2000).transform(normalizeChoiceLabel),
        text: z.string().trim().min(1).max(600),
      }),
    )
    .max(8)
    .default([]),
  correct_label: z.string().min(1).max(2000).transform(normalizeChoiceLabel),
  working: z.string().trim().max(4000).default(''),
})

export type GeneratedQuestion = z.infer<typeof generatedQuestionSchema>

export function parsePractice(raw: unknown): GeneratedQuestion[] {
  const outer = z.object({ questions: z.array(z.unknown()).max(40) }).safeParse(raw)
  if (!outer.success) return []

  const kept: GeneratedQuestion[] = []

  for (const item of outer.data.questions) {
    const parsed = generatedQuestionSchema.safeParse(item)
    if (parsed.success) kept.push(parsed.data)
  }

  return kept
}

export interface ReviewCandidate {
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

  image?: Uint8Array
  mediaType?: string
}

export interface LessonInput {
  topicName: string
  topicPath: string
  samples: string[]
}

export interface PracticeInput {
  topicName: string
  topicPath: string
  owned: string[]
  count: number
}

export interface ExplainInput {
  promptText: string
  choices: { label: string; text: string }[]
  correctAnswer: string | null

  studentAnswer: string | null
}

interface ProviderIdentity {
  readonly name: ProviderName

  readonly model: string

  readonly answeringModel: string

  readonly supportsVision: boolean
  readonly executionSite: ExecutionSite
}

export interface RawAIProvider extends ProviderIdentity {
  extractQuestions(page: PageInput): Promise<unknown>
  classifyTopic(promptText: string, candidates: TopicCandidate[]): Promise<unknown>
  explain(input: ExplainInput): Promise<unknown>

  answerQuestion(input: AnswerInput): Promise<unknown>

  teachTopic(input: LessonInput): Promise<unknown>

  writePractice(input: PracticeInput): Promise<unknown>
}

export interface AIProvider extends ProviderIdentity {
  extractQuestions(page: PageInput): Promise<ExtractedQuestion[]>
  classifyTopic(promptText: string, candidates: TopicCandidate[]): Promise<Classification>
  explain(input: ExplainInput): Promise<Explanation>
  answerQuestion(input: AnswerInput): Promise<Solution>
  teachTopic(input: LessonInput): Promise<Lesson>
  writePractice(input: PracticeInput): Promise<GeneratedQuestion[]>
}

export interface RawQuestionReviewer {
  reviewQuestions(candidates: ReviewCandidate[]): Promise<unknown>
}

export interface QuestionReviewer {
  reviewQuestions(candidates: ReviewCandidate[]): Promise<QuestionReview[]>
}

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

export const CLOUD_PROVIDERS = ['anthropic', 'openai', 'openrouter', 'google'] as const

export type CloudProvider = (typeof CLOUD_PROVIDERS)[number]

export function isCloudProvider(value: string): value is CloudProvider {
  return (CLOUD_PROVIDERS as readonly string[]).includes(value)
}

export const DEFAULT_CLOUD_MODEL: Record<CloudProvider, string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-4.1',
  openrouter: 'google/gemini-2.5-flash',
  google: 'gemini-2.5-flash',
}

export interface ProviderCopy {
  label: string
  keysAt: string
  keyPlaceholder: string
  note: string
}

export const PROVIDER_COPY: Record<CloudProvider, ProviderCopy> = {
  anthropic: {
    label: 'Anthropic',
    keysAt: 'console.anthropic.com',
    keyPlaceholder: 'sk-ant-…',
    note: 'Claude models.',
  },
  openai: {
    label: 'OpenAI',
    keysAt: 'platform.openai.com',
    keyPlaceholder: 'sk-…',
    note: 'GPT models.',
  },
  openrouter: {
    label: 'OpenRouter',
    keysAt: 'openrouter.ai/keys',
    keyPlaceholder: 'sk-or-…',
    note: 'One key reaches Claude, GPT, Gemini and open models. Pick any of them in the model box.',
  },
  google: {
    label: 'Google Gemini',
    keysAt: 'aistudio.google.com/apikey',
    keyPlaceholder: 'AIza…',
    note: 'Gemini models. Has a free tier worth starting on.',
  },
}

export const TRIAL_WORKSHEET_LIMIT = 3

export const TRIAL_EXPLANATION_LIMIT = 20

export function trialDailyCeiling(): number {
  const raw = process.env.TRIAL_DAILY_WORKSHEETS?.trim()
  if (!raw) return 25
  if (raw === 'unlimited') return Number.POSITIVE_INFINITY

  const parsed = Number(raw)

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 25
}
