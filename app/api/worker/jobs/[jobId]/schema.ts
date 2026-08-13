import { z } from 'zod'

import { extractedQuestionSchema } from '@/lib/ai/types'

/**
 * What the worker can report back for one job, as a discriminated union.
 *
 * Split out from `route.ts` so `handlers.ts` can name each action's body type
 * without importing from the route module, which would create the same
 * import cycle the split exists to avoid.
 */
export const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('page_result'),
    pageId: z.string().min(1),
    pageNumber: z.number().int().min(1),
    totalPages: z.number().int().min(1),
    questions: z.array(extractedQuestionSchema).max(100),
  }),
  // Moves the bar past page-reading once the worker starts a later stage, so
  // it does not sit at full while the audit and classification still run.
  z.object({
    action: z.literal('phase'),
    phase: z.enum(['verifying', 'classifying']),
  }),
  // A page read a second time because the review pass doubted some of what it
  // produced. Distinct from page_result: that one only ever adds, so a
  // corrected question would land beside the broken one instead of replacing
  // it, and the student would see both.
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
    /** Null is a real answer here: the model declining to guess. */
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
