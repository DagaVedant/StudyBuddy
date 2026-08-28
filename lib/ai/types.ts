import {z} from 'zod'

import {
  ESCAPE_COLLIDING_COMMANDS,
  normalizeChoiceLabel,
} from '@/lib/questions/shape'

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

const questionTypeSchema = z.enum([
  'multiple_choice', 'free_response', 'true_false', 'fill_blank', 'grid_in',
])

function isBox(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  if (value.length !== 4) return false

  for (const n of value) {
    if (typeof n !== 'number') return false
    if (!Number.isFinite(n)) return false
  }

  return true
}

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

export type ExtractedQuestion = z.infer<typeof extractedQuestionSchema>

type ExtractionRejection = {
  path: string
  message: string
  preview: string
}

function previewOf(item: unknown): string {
  let source = ''

  if (item && typeof item === 'object') {
    const text = (item as {prompt_text?: unknown}).prompt_text
    if (typeof text === 'string' && text.length > 0) source = text
  }

  if (!source) {
    const encoded = JSON.stringify(item)
    if (encoded) source = encoded
  }

  return source.replace(/\s+/g, ' ').slice(0, 70)
}

const RESTATEMENT = /^\s*(the\s+)?question\s+(asks|is\s+asking|requires|wants)\b/i

function parseExtraction(raw: unknown): {
  questions: ExtractedQuestion[]
  rejections: ExtractionRejection[]
} {
  const outer = z.object({questions: z.array(z.unknown()).max(200)}).safeParse(raw)
  if (!outer.success) return {questions: [], rejections: []}

  const questions: ExtractedQuestion[] = []
  const rejections: ExtractionRejection[] = []

  for (const item of outer.data.questions) {
    const parsed = extractedQuestionSchema.safeParse(item)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]

      let path = '(root)'
      let message = 'invalid'

      if (issue) {
        const joined = issue.path.join('.')
        if (joined) path = joined
        if (issue.message) message = issue.message
      }

      rejections.push({path, message, preview: previewOf(item)})
      continue
    }

    if (RESTATEMENT.test(parsed.data.prompt_text)) {
      rejections.push({
        path: 'prompt_text',
        message: 'reads as a restatement of the task rather than a question',
        preview: previewOf(item),
      })
      continue
    }

    questions.push(parsed.data)
  }

  return {questions, rejections}
}

const confidenceSchema = z.preprocess((value) => {
  let raw = Number(value)
  if (typeof value === 'number') raw = value

  if (!Number.isFinite(raw)) return 0

  let normalized = raw
  if (normalized > 1) normalized = normalized / 100

  if (normalized < 0) return 0
  if (normalized > 1) return 1

  return normalized
}, z.number().min(0).max(1))

export const classificationSchema = z.object({
  topic_slug: z.string().nullable(),
  confidence: confidenceSchema.default(0),
  abstain: z.boolean().default(false),
})

export type Classification = z.infer<typeof classificationSchema>

const explanationSchema = z.object({
  body_md: z.string().min(1).max(6000),
  misconception_note: z.string().max(400).nullable().default(null),
})

export type Explanation = z.infer<typeof explanationSchema>

const solutionSchema = z.object({
  answer: z.string().max(400).nullable().default(null),
  working: z.string().max(8000).default(''),
  traps: z
    .array(
      z.object({label: z.string().max(8).nullable().default(null), why: z.string().max(600)}),
    )
    .max(12)
    .default([]),
  confidence: confidenceSchema.default(0),
})

export type Solution = z.infer<typeof solutionSchema>

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

function parsePractice(raw: unknown): GeneratedQuestion[] {
  const outer = z.object({questions: z.array(z.unknown()).max(40)}).safeParse(raw)
  if (!outer.success) return []

  const kept: GeneratedQuestion[] = []

  for (const item of outer.data.questions) {
    const parsed = generatedQuestionSchema.safeParse(item)
    if (parsed.success) kept.push(parsed.data)
  }

  return kept
}

export type ReviewCandidate = {
  number: number
  prompt_text: string
  choices: {label: string; text: string}[]
}

const questionReviewSchema = z.object({
  number: z.coerce
    .number()
    .catch(0)
    .transform((value) => (Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0)),
  intact: z.boolean(),
  reason: z.string().max(400).nullable().default(null),
})

const reviewResultSchema = z.object({
  verdicts: z.array(questionReviewSchema).max(100).default([]),
})

export type QuestionReview = z.infer<typeof questionReviewSchema>

function parseReview(raw: unknown): QuestionReview[] {
  const parsed = reviewResultSchema.safeParse(raw)

  if (!parsed.success) {
    console.warn('[ai] could not read the review reply, treating as no opinion')
    return []
  }

  return parsed.data.verdicts
}

export type PageInput = {
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

export type TopicCandidate = {
  slug: string
  name: string
  path: string
}

export type AnswerInput = {
  promptText: string
  choices: {label: string; text: string}[]

  image?: Uint8Array
  mediaType?: string
}

export type LessonInput = {
  topicName: string
  topicPath: string
  samples: string[]
}

export type PracticeInput = {
  topicName: string
  topicPath: string
  owned: string[]
  count: number
}

export type ExplainInput = {
  promptText: string
  choices: {label: string; text: string}[]
  correctAnswer: string | null
  studentAnswer: string | null
}

type ProviderIdentity = {
  readonly name: ProviderName
  readonly model: string
  readonly answeringModel: string
  readonly supportsVision: boolean
  readonly executionSite: ExecutionSite
}

export type RawAIProvider = ProviderIdentity & {
  extractQuestions(page: PageInput): Promise<unknown>
  classifyTopic(promptText: string, candidates: TopicCandidate[]): Promise<unknown>
  explain(input: ExplainInput): Promise<unknown>
  answerQuestion(input: AnswerInput): Promise<unknown>
  teachTopic(input: LessonInput): Promise<unknown>
  writePractice(input: PracticeInput): Promise<unknown>
}

export type AIProvider = ProviderIdentity & {
  extractQuestions(page: PageInput): Promise<ExtractedQuestion[]>
  classifyTopic(promptText: string, candidates: TopicCandidate[]): Promise<Classification>
  explain(input: ExplainInput): Promise<Explanation>
  answerQuestion(input: AnswerInput): Promise<Solution>
  teachTopic(input: LessonInput): Promise<Lesson>
  writePractice(input: PracticeInput): Promise<GeneratedQuestion[]>
}

export type RawQuestionReviewer = {
  reviewQuestions(candidates: ReviewCandidate[]): Promise<unknown>
}

export type QuestionReviewer = {
  reviewQuestions(candidates: ReviewCandidate[]): Promise<QuestionReview[]>
}

function canReview<T extends object>(provider: T): provider is T & QuestionReviewer {
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

type ProviderCopy = {
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
  const value = process.env.TRIAL_DAILY_WORKSHEETS
  if (!value) return 25

  const raw = value.trim()
  if (!raw) return 25
  if (raw === 'unlimited') return Infinity

  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return 25
  if (parsed < 0) return 25

  return parsed
}

const JSON_ESCAPE_LETTERS = new Set(['b', 'f', 'n', 'r', 't', 'u'])

function repairLatexEscapes(text: string): string {
  let out = ''
  let inString = false
  let i = 0

  while (i < text.length) {
    const char = text[i]

    if (!inString) {
      if (char === '"') inString = true
      out += char
      i += 1
      continue
    }

    if (char !== '\\') {
      if (char === '"') inString = false
      out += char
      i += 1
      continue
    }

    const letters = /^[a-zA-Z]+/.exec(text.slice(i + 1))

    let run = ''
    if (letters) run = letters[0]

    if (run && (!JSON_ESCAPE_LETTERS.has(run[0]) || ESCAPE_COLLIDING_COMMANDS.has(run))) {
      out += '\\\\' + run
      i += 1 + run.length
      continue
    }

    out += text.slice(i, i + 2)
    i += 2
  }

  return out
}

function salvageTruncatedJson(text: string): unknown | null {
  const arrayStart = text.indexOf('[')
  if (arrayStart === -1) return null

  let depth = 0
  let inString = false
  let escaped = false
  let lastCompleteEntry = -1

  for (let i = arrayStart + 1; i < text.length; i += 1) {
    const char = text[i]

    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) lastCompleteEntry = i
      else if (depth < 0) break
    }
  }

  if (lastCompleteEntry === -1) return null

  const rebuilt = (text.slice(0, lastCompleteEntry + 1)) + ']}'

  try {
    return JSON.parse(rebuilt)
  } catch {
    return null
  }
}

type LenientParse = {
  value: unknown
  truncated: boolean
}

export function parseModelJson(text: string): LenientParse {
  const repaired = repairLatexEscapes(text)

  try {
    return {value: JSON.parse(repaired), truncated: false}
  } catch {
    const salvaged = salvageTruncatedJson(repaired)

    if (salvaged === null) {
      throw new Error(
        'Model returned unparseable JSON (' +
          text.length +
          ' chars) and nothing could be salvaged.',
      )
    }

    return {value: salvaged, truncated: true}
  }
}

type Validated<T> = T extends {reviewQuestions: unknown}
  ? AIProvider & QuestionReviewer
  : AIProvider

export function validated<T extends RawAIProvider>(provider: T): Validated<T> {
  const wrapped: AIProvider = {
    name: provider.name,
    model: provider.model,
    answeringModel: provider.answeringModel,
    supportsVision: provider.supportsVision,
    executionSite: provider.executionSite,

    async extractQuestions(page) {
      const read = parseExtraction(await provider.extractQuestions(page))
      const questions = read.questions
      const rejections = read.rejections

      if (rejections.length > 0) {
        const onOperatorMachine = provider.executionSite === 'operator_gpu'

        console.warn(
          '[ai] ' +
            provider.name +
            ' page ' +
            page.pageNumber +
            ': dropped ' +
            rejections.length +
            ' unreadable question(s), kept ' +
            questions.length,
        )

        for (const rejection of rejections) {
          let line = '  - ' + rejection.path + ': ' + rejection.message
          if (!onOperatorMachine) line = line + ' :: ' + rejection.preview

          console.warn(line)
        }
      }

      return questions
    },

    async classifyTopic(promptText, candidates) {
      return classificationSchema.parse(await provider.classifyTopic(promptText, candidates))
    },

    async answerQuestion(input) {
      return solutionSchema.parse(await provider.answerQuestion(input))
    },

    async teachTopic(input) {
      return lessonSchema.parse(await provider.teachTopic(input))
    },

    async writePractice(input) {
      return parsePractice(await provider.writePractice(input))
    },

    async explain(input) {
      return explanationSchema.parse(await provider.explain(input))
    },
  }

  if (canReview(provider)) {
    const reviewing: AIProvider & QuestionReviewer = {
      ...wrapped,

      async reviewQuestions(candidates) {
        return parseReview(await provider.reviewQuestions(candidates))
      },
    }

    return reviewing as Validated<T>
  }

  return wrapped as Validated<T>
}
