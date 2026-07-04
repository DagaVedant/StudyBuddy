import { z } from 'zod'

export const bboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()])

/**
 * Models return choice labels inconsistently — "A", "A.", "A)", "(A)". The UI
 * supplies its own separator, so trailing punctuation has to come off or it
 * renders as "A..". Applied at render too, so rows stored before this
 * normalisation existed still display correctly.
 */
export function choiceLabel(raw: string): string {
  return raw.trim().replace(/^\(|[).\s]+$/g, '') || raw.trim()
}

/**
 * Vision models return labels as "A.", "A)", "(A)" depending on the page's own
 * formatting. Stored labels are bare ("A") — the UI adds its own punctuation,
 * and "A.." was what shipped without this.
 */
export function normalizeChoiceLabel(label: string): string {
  const cleaned = label.trim().replace(/^[([]+/, '').replace(/[.)\]\s]+$/, '')
  return (cleaned || label.trim()).slice(0, 8)
}

export const choiceSchema = z.object({
  label: z.string().trim().min(1).max(8).transform(normalizeChoiceLabel),
  text: z.string().trim().max(2000),
  isCorrect: z.boolean().default(false),
})

export const questionInputSchema = z.object({
  pageId: z.string().min(1).nullish(),
  ordinal: z.number().int().min(1),
  promptText: z.string().trim().min(1).max(8000),
  questionType: z.enum([
    'multiple_choice',
    'free_response',
    'true_false',
    'fill_blank',
    'grid_in',
  ]),
  bbox: bboxSchema.nullish(),
  correctAnswer: z.string().trim().max(2000).nullish(),
  choices: z.array(choiceSchema).max(12).default([]),
  topicId: z.string().min(1).nullish(),
})

export type QuestionInput = z.infer<typeof questionInputSchema>

/**
 * Normalized hash for exact-duplicate detection within a user (spec §6.3).
 * Punctuation and spacing vary between OCR passes of the same question, so
 * they're stripped before hashing.
 */
export function normalizeForCompare(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

export function contentHashSource(promptText: string, choices: { text: string }[]): string {
  return [
    normalizeForCompare(promptText),
    ...choices.map((choice) => normalizeForCompare(choice.text)),
  ]
    .filter(Boolean)
    .join('|')
}
