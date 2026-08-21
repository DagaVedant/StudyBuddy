import {and, asc, desc, eq, inArray, notExists, sql} from 'drizzle-orm'

import {
  answerChoices,
  attempts,
  questions,
  questionSolutions,
  worksheetPages,
} from '@/lib/db/schema'
import {
  modalChoiceCount,
  type ValidatableQuestion,
  validateQuestion,
  worthRereading,
} from '@/lib/questions/validate'
import {
  type AIProvider,
  type QuestionReview,
  type ReviewCandidate,
} from '@/lib/ai/types'
import {CHOICE_ORDER} from '@/lib/questions/queries'
import {normalizeChoiceLabel} from '@/lib/questions/shape'
import {printedNumbersFor} from '@/lib/questions/numbering'
import {type Db} from '@/lib/db'

const PROMOTE_ABOVE = 0.6

export const UNSOLVED_PAGE_SIZE = 500

export interface UnsolvedQuestion {
  id: string
  promptText: string
  printedNumber: number | null
  pageId: string | null
  pageImageKey: string | null
  choices: {label: string; text: string}[]
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
            .select({one: sql`1`})
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

  const byQuestion = new Map<string, {label: string; text: string}[]>()
  for (const choice of choices) {
    const list = byQuestion.get(choice.questionId) ?? []
    list.push({label: choice.label, text: choice.text})
    byQuestion.set(choice.questionId, list)
  }

  const pageIds = [...new Set(rows.map((row) => row.pageId).filter((id) => id !== null))]

  const pages = pageIds.length
    ? await db
        .select({id: worksheetPages.id, imageKey: worksheetPages.imageKey})
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
  const progress: SolutionProgress = {solved: 0, promoted: 0, refused: 0, failed: 0}

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
            .select({one: sql`1`})
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
      .select({label: answerChoices.label, text: answerChoices.text})
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
        
        
        .onConflictDoNothing({target: questionSolutions.questionId})

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
    choices: {label: string; text: string}[]
    answerSource: string
  },
): Promise<boolean> {
  const {questionId, answer, confidence, choices, answerSource} = input

  if (answer === null) return false
  if (answerSource !== 'none') return false
  if (confidence < PROMOTE_ABOVE) return false

  const stored = storedAnswer(answer, choices)
  if (!stored) return false

  const updated = await db
    .update(questions)
    .set({correctAnswer: stored, answerSource: 'ai_derived'})
    .where(and(eq(questions.id, questionId), eq(questions.answerSource, 'none')))
    .returning({id: questions.id})

  return updated.length > 0
}

export function storedAnswer(
  answer: string,
  choices: {label: string; text: string}[],
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

export interface ExplainInput {
  questionId: string
  attemptId: string | null
  promptText: string
  choices: {label: string; text: string}[]
  correctAnswer: string | null
  studentAnswer: string | null
}

export async function explainInput(
  db: Db,
  userId: string,
  questionId: string,
): Promise<ExplainInput | null> {
  const [question] = await db
    .select()
    .from(questions)
    .where(and(eq(questions.id, questionId), eq(questions.userId, userId)))
    .limit(1)

  if (!question) return null

  const choices = await db
    .select()
    .from(answerChoices)
    .where(eq(answerChoices.questionId, question.id))
    .orderBy(...CHOICE_ORDER)

  const [lastAttempt] = await db
    .select()
    .from(attempts)
    .where(and(eq(attempts.userId, userId), eq(attempts.questionId, question.id)))
    .orderBy(desc(attempts.createdAt))
    .limit(1)

  const studentAnswer =
    choices.find((choice) => choice.id === lastAttempt?.selectedChoiceId)?.label ??
    lastAttempt?.freeTextAnswer ??
    null

  return {
    questionId: question.id,
    attemptId: lastAttempt?.id ?? null,
    promptText: question.promptText,
    choices: choices.map((choice) => ({label: choice.label, text: choice.text})),
    correctAnswer:
      choices.find((choice) => choice.isCorrect)?.label ?? question.correctAnswer,
    studentAnswer,
  }
}
export interface ReviewableQuestion extends ValidatableQuestion {
  id: string
  pageNumber: number
}

export interface Suspect {
  id: string
  pageNumber: number
  printedNumber: number | null
  reasons: string[]
}

export interface ReviewPlan {
  suspects: Suspect[]
  reread: {pageNumber: number; expect: number[]}[]
  skippedPages: number[]
  modelConsulted: boolean
}

export type ReviewFn = (candidates: ReviewCandidate[]) => Promise<QuestionReview[]>

export interface DoubtedQuestion {
  id: string
  printedNumber: number | null
}

export interface PageReplacement<T> {
  replace: DoubtedQuestion[]
  keep: DoubtedQuestion[]
  replacements: T[]
}

export function planPageReplacement<T extends {ordinal: number; prompt_text: string}>(
  pageText: string,
  fresh: readonly T[],
  doubted: readonly DoubtedQuestion[],
): PageReplacement<T> {
  const fromPage = printedNumbersFor(
    pageText,
    fresh.map((question) => question.prompt_text),
  )

  const numberAt = (index: number): number | null => {
    if (fromPage[index] !== null) return fromPage[index]
    const counted = fresh[index].ordinal
    return counted >= 1 ? counted : null
  }

  const refound = new Set(
    fresh.map((_, index) => numberAt(index)).filter((n): n is number => n !== null),
  )

  const replace = doubted.filter(
    (row) => row.printedNumber !== null && refound.has(row.printedNumber),
  )
  const keep = doubted.filter((row) => !replace.includes(row))

  const wanted = new Set(
    replace.map((row) => row.printedNumber).filter((n): n is number => n !== null),
  )

  const replacements = fresh.filter((_, index) => {
    const number = numberAt(index)
    return number !== null && wanted.has(number)
  })

  return {replace, keep, replacements}
}

export const MAX_REREAD_SHARE = 0.3

export async function planReview(
  questions: ReviewableQuestion[],
  review?: ReviewFn,
  options: {maxRereadShare?: number} = {},
): Promise<ReviewPlan> {
  const expectedChoiceCount = modalChoiceCount(questions)

  const suspects = new Map<string, Suspect>()

  const flag = (question: ReviewableQuestion, reason: string) => {
    const existing = suspects.get(question.id)
    if (existing) {
      existing.reasons.push(reason)
      return
    }
    suspects.set(question.id, {
      id: question.id,
      pageNumber: question.pageNumber,
      printedNumber: question.printedNumber,
      reasons: [reason],
    })
  }

  for (const question of questions) {
    const flags = validateQuestion(question, {expectedChoiceCount})
    if (worthRereading(flags)) {
      for (const f of flags) flag(question, f.detail)
    }
  }

  
  
  const unreviewed = questions.filter(
    (q) => !suspects.has(q.id) && q.printedNumber !== null,
  )

  let modelConsulted = false

  if (review && unreviewed.length > 0) {
    const byPage = new Map<number, ReviewableQuestion[]>()
    for (const question of unreviewed) {
      byPage.set(question.pageNumber, [...(byPage.get(question.pageNumber) ?? []), question])
    }

    for (const [, batch] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
      try {
        const verdicts = await review(
          batch.map((q) => ({
            number: q.printedNumber as number,
            prompt_text: q.promptText,
            choices: q.choices,
          })),
        )

        modelConsulted = true

        const byNumber = new Map(batch.map((q) => [q.printedNumber, q]))
        for (const verdict of verdicts) {
          if (verdict.intact) continue
          const question = byNumber.get(verdict.number)
          if (question) flag(question, verdict.reason ?? 'the reviewer called it damaged')
        }
      } catch (error) {
        console.error('[review] could not review a page, continuing:', error)
      }
    }
  }

  const pages = new Set(questions.map((q) => q.pageNumber))
  const cap = Math.max(1, Math.ceil(pages.size * (options.maxRereadShare ?? MAX_REREAD_SHARE)))

  const byPage = new Map<number, number[]>()
  for (const suspect of suspects.values()) {
    if (suspect.printedNumber === null) continue
    byPage.set(suspect.pageNumber, [...(byPage.get(suspect.pageNumber) ?? []), suspect.printedNumber])
  }

  const ordered = [...byPage.entries()]
    .map(([pageNumber, expect]) => ({
      pageNumber,
      expect: [...new Set(expect)].sort((a, b) => a - b),
    }))
    .sort((a, b) => b.expect.length - a.expect.length || a.pageNumber - b.pageNumber)

  return {
    suspects: [...suspects.values()].sort(
      (a, b) => a.pageNumber - b.pageNumber || (a.printedNumber ?? 0) - (b.printedNumber ?? 0),
    ),
    reread: ordered.slice(0, cap).sort((a, b) => a.pageNumber - b.pageNumber),
    skippedPages: ordered.slice(cap).map((p) => p.pageNumber).sort((a, b) => a - b),
    modelConsulted,
  }
}
