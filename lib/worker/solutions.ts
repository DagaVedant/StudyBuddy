import { and, asc, eq, inArray, notExists, sql } from 'drizzle-orm'

import type { AIProvider } from '@/lib/ai/types'
import {
  answerChoices,
  questionSolutions,
  questions,
  worksheetPages,
} from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'
import { CHOICE_ORDER } from '@/lib/questions/sql'
import { normalizeChoiceLabel } from '@/lib/questions/shape'

const PROMOTE_ABOVE = 0.6

export const UNSOLVED_PAGE_SIZE = 500

export interface UnsolvedQuestion {
  id: string
  promptText: string
  printedNumber: number | null
  pageId: string | null
  pageImageKey: string | null
  choices: { label: string; text: string }[]
}

export async function unsolvedQuestions(
  db: Db,
  worksheetId: string,
  limit = UNSOLVED_PAGE_SIZE,
): Promise<UnsolvedQuestion[]> {
  const rows = await db
    .select({
      id: questions.id,
      promptText: questions.promptText,
      printedNumber: questions.printedNumber,
      pageId: questions.pageId,
    })
    .from(questions)
    .where(
      and(
        eq(questions.worksheetId, worksheetId),
        notExists(
          db
            .select({ one: sql`1` })
            .from(questionSolutions)
            .where(eq(questionSolutions.questionId, questions.id)),
        ),
      ),
    )
    .orderBy(asc(questions.ordinal), asc(questions.id))
    .limit(limit)

  if (rows.length === 0) return []

  const choices = await db
    .select({
      questionId: answerChoices.questionId,
      label: answerChoices.label,
      text: answerChoices.text,
    })
    .from(answerChoices)
    .where(
      inArray(
        answerChoices.questionId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(...CHOICE_ORDER)

  const byQuestion = new Map<string, { label: string; text: string }[]>()
  for (const choice of choices) {
    const list = byQuestion.get(choice.questionId) ?? []
    list.push({ label: choice.label, text: choice.text })
    byQuestion.set(choice.questionId, list)
  }

  const pageIds = [...new Set(rows.map((row) => row.pageId).filter((id) => id !== null))]

  const pages = pageIds.length
    ? await db
        .select({ id: worksheetPages.id, imageKey: worksheetPages.imageKey })
        .from(worksheetPages)
        .where(inArray(worksheetPages.id, pageIds))
    : []

  const imageKeyFor = new Map(pages.map((page) => [page.id, page.imageKey]))

  return rows.map((row) => ({
    id: row.id,
    promptText: row.promptText,
    printedNumber: row.printedNumber,
    pageId: row.pageId,
    pageImageKey: row.pageId ? (imageKeyFor.get(row.pageId) ?? null) : null,
    choices: byQuestion.get(row.id) ?? [],
  }))
}

export interface SolutionProgress {
  solved: number
  promoted: number
  refused: number
  failed: number
}

export async function deriveSolutions(
  db: Db,
  provider: AIProvider,
  worksheetId: string,
  options: {
    limit?: number
    onProgress?: (done: number, total: number) => Promise<void> | void
    log?: ((message: string) => void) | null
  } = {},
): Promise<SolutionProgress> {
  const log = options.log === undefined ? console.log : options.log
  const progress: SolutionProgress = { solved: 0, promoted: 0, refused: 0, failed: 0 }

  const pending = await db
    .select({
      id: questions.id,
      promptText: questions.promptText,
      answerSource: questions.answerSource,
    })
    .from(questions)
    .where(
      and(
        eq(questions.worksheetId, worksheetId),
        notExists(
          db
            .select({ one: sql`1` })
            .from(questionSolutions)
            .where(eq(questionSolutions.questionId, questions.id)),
        ),
      ),
    )
    .orderBy(asc(questions.ordinal), asc(questions.id))
    .limit(options.limit ?? 500)

  if (pending.length === 0) return progress

  for (const [index, question] of pending.entries()) {
    const choices = await db
      .select({ label: answerChoices.label, text: answerChoices.text })
      .from(answerChoices)
      .where(eq(answerChoices.questionId, question.id))
      .orderBy(...CHOICE_ORDER)

    try {
      const solution = await provider.answerQuestion({
        promptText: question.promptText,
        choices,
      })

      await db
        .insert(questionSolutions)
        .values({
          questionId: question.id,
          derivedAnswer: solution.answer,
          workingMd: solution.working,
          traps: solution.traps,
          confidence: solution.confidence,
          provider: storedProviderName(provider.name),
          model: provider.answeringModel,
        })
        
        
        .onConflictDoNothing({ target: questionSolutions.questionId })

      if (solution.answer === null) {
        progress.refused += 1
      } else {
        progress.solved += 1

        const promoted = await promoteDerivedAnswer(db, {
          questionId: question.id,
          answer: solution.answer,
          confidence: solution.confidence,
          choices,
          answerSource: question.answerSource,
        })
        if (promoted) progress.promoted += 1
      }
    } catch (error) {
      progress.failed += 1
      log?.(
        `[solutions] question ${question.id} could not be solved: ${(error as Error).message}`,
      )
    }

    await options.onProgress?.(index + 1, pending.length)
  }

  log?.(
    `[solutions] ${worksheetId}: ${progress.solved} solved, ${progress.promoted} promoted, ` +
      `${progress.refused} declined, ${progress.failed} failed`,
  )

  return progress
}

export async function promoteDerivedAnswer(
  db: Db,
  input: {
    questionId: string
    answer: string | null
    confidence: number
    choices: { label: string; text: string }[]
    answerSource: string
  },
): Promise<boolean> {
  const { questionId, answer, confidence, choices, answerSource } = input

  if (answer === null) return false
  if (answerSource !== 'none') return false
  if (confidence < PROMOTE_ABOVE) return false

  const stored = storedAnswer(answer, choices)
  if (!stored) return false

  const updated = await db
    .update(questions)
    .set({ correctAnswer: stored, answerSource: 'ai_derived' })
    .where(and(eq(questions.id, questionId), eq(questions.answerSource, 'none')))
    .returning({ id: questions.id })

  return updated.length > 0
}

export function storedAnswer(
  answer: string,
  choices: { label: string; text: string }[],
): string | null {
  const trimmed = answer.trim()
  if (!trimmed) return null

  if (choices.length === 0) return trimmed.slice(0, 200)

  const label = normalizeChoiceLabel(trimmed).toLowerCase()
  const byLabel = choices.find((choice) => choice.label.toLowerCase() === label)
  if (byLabel) return byLabel.label

  const byText = choices.find(
    (choice) => choice.text.trim().toLowerCase() === trimmed.toLowerCase(),
  )
  return byText ? byText.label : null
}

function storedProviderName(
  name: string,
): 'anthropic' | 'openai' | 'openrouter' | 'google' | 'ollama' | null {
  switch (name) {
    case 'anthropic':
    case 'openai':
    case 'openrouter':
    case 'google':
    case 'ollama':
      return name
    default:
      return null
  }
}
