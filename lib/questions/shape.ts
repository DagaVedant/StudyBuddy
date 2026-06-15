import { z } from 'zod'

export const bboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()])

export const choiceSchema = z.object({
  label: z.string().trim().min(1).max(8),
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
export function contentHashSource(promptText: string, choices: { text: string }[]): string {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()

  return [normalize(promptText), ...choices.map((choice) => normalize(choice.text))]
    .filter(Boolean)
    .join('|')
}
