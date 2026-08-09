import { createHash } from 'node:crypto'

import { z } from 'zod'

export const bboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()])

export function choiceLabel(raw: string): string {
  return raw.trim().replace(/^\(|[).\s]+$/g, '') || raw.trim()
}

/**
 * A choice's label, reduced to the label itself.
 *
 * The extractor sometimes returns the whole option in this field (`A. 60`
 * rather than `A`) and everything downstream then treats the option text as
 * part of its own name: the review screen renders "A. 60. 60", and the answer
 * key cannot tell which option the paper marked correct, because it is looking
 * for `C` and finding `C. 53`. A letter followed by its punctuation and then
 * more text is a label with its option stuck to it, so the letter is taken and
 * the rest dropped. Numeric labels are left alone; a paper that answers with
 * sentence numbers means them literally.
 */
export function normalizeChoiceLabel(label: string): string {
  const cleaned = label.trim().replace(/^[([]+/, '').replace(/[.)\]\s]+$/, '')
  const letterOnly = /^([A-Za-z])\s*[.):\]]\s*\S/.exec(cleaned)

  return (letterOnly?.[1] ?? (cleaned || label.trim())).slice(0, 8)
}

export const choiceSchema = z.object({
  // Bounded before the transform, not instead of it: the raw value may be a
  // whole option, which is the case {@link normalizeChoiceLabel} exists to
  // handle, and it clamps its own result to 8. Checking 8 against the input
  // rejected exactly the values the transform was written to repair.
  label: z.string().trim().min(1).max(2000).transform(normalizeChoiceLabel),
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
  /**
   * Optional rather than `.default([])`, because this schema is also used
   * through `.partial()` by the PATCH route, and `.partial()` does not
   * suppress a default: a body that never mentions choices still parsed to
   * `[]`, which that route reads as "replace the choices with none". The
   * verify screen sends exactly `{ userVerified: true }`, so confirming that a
   * question had been read correctly deleted every one of its answers.
   * Creators supply `?? []` themselves.
   */
  choices: z.array(choiceSchema).max(12).optional(),
  topicId: z.string().min(1).nullish(),
  /** Set when a person has confirmed the question was scanned correctly. */
  userVerified: z.boolean().optional(),
})

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

/**
 * The dedupe identity for a question, everywhere.
 *
 * Six places used to spell this out (ingest, the split join, the carried
 * options recovery, the maths repair, and both question write routes) and a
 * disagreement between any two of them means a question stops matching itself
 * and the next pass stores a second copy. That has happened twice. There is
 * exactly one way to compute it now.
 */
export function hashQuestion(promptText: string, choices: { text: string }[]): string {
  return createHash('sha256').update(contentHashSource(promptText, choices)).digest('hex')
}
