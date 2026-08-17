import { z } from 'zod'

import { extractedQuestionSchema } from '@/lib/ai/types'

export const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('page_result'),
    pageId: z.string().min(1),
    pageNumber: z.number().int().min(1),
    totalPages: z.number().int().min(1),
    questions: z.array(extractedQuestionSchema).max(100),
  }),
  z.object({
    action: z.literal('phase'),
    phase: z.enum(['verifying', 'classifying']),
  }),
  z.object({
    action: z.literal('page_review'),
    pageId: z.string().min(1),
    replace: z.array(z.string().uuid()).max(100),
    questions: z.array(extractedQuestionSchema).max(100),
  }),
  z.object({
    action: z.literal('explanation'),
    questionId: z.string().uuid(),
    attemptId: z.string().uuid().nullish(),
    bodyMd: z.string().min(1).max(6000),
    misconceptionNote: z.string().max(400).nullish(),
    model: z.string().max(200),
  }),
  z.object({
    action: z.literal('solution'),
    questionId: z.string().uuid(),
    answer: z.string().max(400).nullable(),
    workingMd: z.string().max(8000),
    traps: z
      .array(z.object({ label: z.string().max(8).nullable(), why: z.string().max(600) }))
      .max(12)
      .default([]),
    confidence: z.number().min(0).max(1),
    model: z.string().max(200),
  }),
  z.object({ action: z.literal('complete') }),
  z.object({ action: z.literal('fail'), message: z.string().max(2000) }),
])
