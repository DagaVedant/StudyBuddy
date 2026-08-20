import { createHash } from 'node:crypto'

import { z } from 'zod'

export const bboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()])

export function choiceLabel(raw: string): string {
  return raw.trim().replace(/^\(|[).\s]+$/g, '') || raw.trim()
}

export function normalizeChoiceLabel(label: string): string {
  const cleaned = label.trim().replace(/^[([]+/, '').replace(/[.)\]\s]+$/, '')
  const letterOnly = /^([A-Za-z])\s*[.):\]]\s*\S/.exec(cleaned)

  return (letterOnly?.[1] ?? (cleaned || label.trim())).slice(0, 8)
}

export const choiceSchema = z.object({
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
  choices: z.array(choiceSchema).max(12).optional(),
  topicId: z.string().min(1).nullish(),
  userVerified: z.boolean().optional(),
})

export function normalizeForCompare(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

export function normalizeOptionText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/gu, '')
}

export function contentHashSource(promptText: string, choices: { text: string }[]): string {
  return [
    normalizeForCompare(promptText),
    ...choices.map((choice) => normalizeForCompare(choice.text)),
  ]
    .filter(Boolean)
    .join('|')
}

export function hashQuestion(promptText: string, choices: { text: string }[]): string {
  return createHash('sha256').update(contentHashSource(promptText, choices)).digest('hex')
}

export interface FoldableQuestion {
  prompt_text: string
  choices: { label: string; text: string }[]
}

const ALPHABETIC = /^[a-z]$/i
const NUMERIC = /^\d+$/

export function foldLeadInChoices<T extends FoldableQuestion>(question: T): T {
  const lettered = question.choices.filter((choice) =>
    ALPHABETIC.test(choice.label.trim()),
  )
  const numbered = question.choices.filter((choice) => NUMERIC.test(choice.label.trim()))

  if (lettered.length < 2 || numbered.length === 0) return question

  const stem = question.prompt_text.trim()
  const seen = new Set([normalizeForCompare(stem)].filter(Boolean))
  const lines: string[] = []

  for (const choice of [...numbered].sort(
    (a, b) => Number(a.label) - Number(b.label),
  )) {
    const text = choice.text.trim()
    if (!text) continue

    const normalized = normalizeForCompare(text)
    if (!normalized || [...seen].some((prior) => prior.includes(normalized))) continue

    seen.add(normalized)
    lines.push(`${Number(choice.label)}. ${text}`)
  }

  return {
    ...question,
    prompt_text: [stem, ...lines].join('\n'),
    choices: question.choices.filter((choice) => !NUMERIC.test(choice.label.trim())),
  }
}
