import { z } from 'zod'

import { normalizeChoiceLabel } from '@/lib/questions/shape'

/**
 * The provider contract (spec §3.5). One interface, five implementations.
 *
 * Every method's output is schema-validated before it reaches the database.
 * Page content is data, never instructions — the prompt templates are fixed
 * and users never supply them (spec §8 threat model).
 */

export type ExecutionSite = 'server' | 'browser' | 'operator_gpu'
export type ProviderName = 'anthropic' | 'openai' | 'ollama' | 'operator_gpu' | 'mock' | 'null'

export const questionTypeSchema = z.enum([
  'multiple_choice',
  'free_response',
  'true_false',
  'fill_blank',
  'grid_in',
])

export const extractedQuestionSchema = z.object({
  /**
   * Advisory only — the server renumbers questions sequentially per worksheet,
   * so this never reaches the database. Models number from 0 about half the
   * time, and requiring >= 1 here silently discarded whole pages of otherwise
   * perfect extraction. Normalize instead of rejecting.
   */
  /*
   * 0 means "this question has no printed number", and must survive as its own
   * value rather than being clamped up to 1. Ingest merges a page's entries by
   * printed number, so if every unnumbered question arrived as 1 they would all
   * collapse into a single question.
   */
  ordinal: z.coerce
    .number()
    .catch(0)
    .transform((value) => (Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0)),
  prompt_text: z.string().min(1).max(8000),
  question_type: questionTypeSchema,
  choices: z
    .array(
      z.object({
        // Models echo the page's own punctuation ("A.", "(B)"); store bare.
        label: z.string().min(1).max(8).transform(normalizeChoiceLabel),
        text: z.string().max(2000),
      }),
    )
    .max(12)
    .default([]),
  /** [x0, y0, x1, y1] in page-image pixels; null when the model can't place it. */
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable().default(null),
  has_figure: z.boolean().default(false),
})

export const extractionResultSchema = z.object({
  questions: z.array(extractedQuestionSchema).max(100),
})

export type ExtractedQuestion = z.infer<typeof extractedQuestionSchema>

/**
 * Validates a page's extraction question-by-question and keeps what survives.
 *
 * Whole-object parsing meant a single malformed question discarded every other
 * question on the page. On a 112-page test that is catastrophic and invisible:
 * the page simply reports zero questions and the run still "succeeds".
 */
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

/**
 * An answer-explanation restates the question it is about before analysing the
 * options — "The question asks which revision of sentence 2 uses the most
 * precise language." A vision model reads that as a question, and no prompt
 * wording changes its mind: naming the pattern, leading with it, and
 * describing the page layout were each tested against real explanation pages
 * and every one still returned the restatements verbatim.
 *
 * So it is filtered here, where the behaviour is deterministic and testable,
 * rather than hoped for. What makes this safe is that a question never opens
 * by describing itself in the third person — it just asks.
 */
const RESTATEMENT = /^\s*(the\s+)?question\s+(asks|is\s+asking|requires|wants)\b/i

function isRestatement(promptText: string): boolean {
  return RESTATEMENT.test(promptText)
}

/**
 * Models emit confidence as a probability (0.95) or a percentage (95)
 * depending on the model and the day. Normalize instead of rejecting — a
 * scale slip should not discard an otherwise-correct classification.
 */
const confidenceSchema = z.preprocess((value) => {
  const raw = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(raw)) return 0
  const normalized = raw > 1 ? raw / 100 : raw
  return Math.min(Math.max(normalized, 0), 1)
}, z.number().min(0).max(1))

export const classificationSchema = z.object({
  /** Must be one of the supplied candidate slugs, or null to abstain. */
  topic_slug: z.string().nullable(),
  confidence: confidenceSchema.default(0),
  abstain: z.boolean().default(false),
  /** Only when abstaining — becomes a topic_proposal for admin review. */
  suggested_name: z.string().max(120).nullable().default(null),
})

export type Classification = z.infer<typeof classificationSchema>

export const explanationSchema = z.object({
  body_md: z.string().min(1).max(6000),
  /** One line naming the specific mistake, when the student's answer is known. */
  misconception_note: z.string().max(400).nullable().default(null),
})

export type Explanation = z.infer<typeof explanationSchema>

export interface PageInput {
  /** Raw page image bytes; base64-encoded by providers that need it. */
  image: Uint8Array
  mediaType: string
  /** OCR or embedded text, supplied as a cheap prior alongside the image. */
  text: string
  width: number
  height: number
  pageNumber: number
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
  /** What the student actually put — the whole reason explanations are useful. */
  studentAnswer: string | null
}

export interface AIProvider {
  readonly name: ProviderName
  readonly supportsVision: boolean
  readonly executionSite: ExecutionSite

  extractQuestions(page: PageInput): Promise<ExtractedQuestion[]>
  classifyTopic(promptText: string, candidates: TopicCandidate[]): Promise<Classification>
  explain(input: ExplainInput): Promise<Explanation>
}

/** Thrown by NullProvider so callers can route to the manual flow (spec §3.5). */
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
