import { createHash } from 'node:crypto'

import { z } from 'zod'

export const bboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()])

export function choiceLabel(raw: string): string {
  return raw.trim().replace(/^\(|[).\s]+$/g, '') || raw.trim()
}

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
 * Six places used to spell this out — ingest, the split join, the carried
 * options recovery, the maths repair, and both question write routes — and a
 * disagreement between any two of them means a question stops matching itself
 * and the next pass stores a second copy. That has happened twice. There is
 * exactly one way to compute it now.
 */
export function hashQuestion(promptText: string, choices: { text: string }[]): string {
  return createHash('sha256').update(contentHashSource(promptText, choices)).digest('hex')
}
