import {and, asc, desc, eq, inArray, notExists, sql} from 'drizzle-orm'

import {answerChoices, attempts, questions, questionSolutions, worksheetPages} from '@/lib/schema'
import {
  modalChoiceCount,
  type ValidatableQuestion,
  validateQuestion,
  worthRereading,
} from '@/lib/questions/numbering'
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

const UNSOLVED_PAGE_SIZE = 500

export type UnsolvedQuestion = {
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

  const ids: string[] = []
  for (const row of rows) ids.push(row.id)

  const choices = await db
    .select({
      questionId: answerChoices.questionId,
      label: answerChoices.label,
      text: answerChoices.text,
    })
    .from(answerChoices)
    .where(inArray(answerChoices.questionId, ids))
    .orderBy(...CHOICE_ORDER)

  const byQuestion = new Map<string, {label: string; text: string}[]>()

  for (const choice of choices) {
    let list = byQuestion.get(choice.questionId)

    if (!list) {
      list = []
      byQuestion.set(choice.questionId, list)
    }

    list.push({label: choice.label, text: choice.text})
  }

  const seenPages = new Set<string>()
  const pageIds: string[] = []

  for (const row of rows) {
    if (row.pageId === null) continue
    if (seenPages.has(row.pageId)) continue

    seenPages.add(row.pageId)
    pageIds.push(row.pageId)
  }

  const imageKeyFor = new Map<string, string>()

  if (pageIds.length > 0) {
    const pages = await db
      .select({id: worksheetPages.id, imageKey: worksheetPages.imageKey})
      .from(worksheetPages)
      .where(inArray(worksheetPages.id, pageIds))

    for (const page of pages) imageKeyFor.set(page.id, page.imageKey)
  }

  const unsolved: UnsolvedQuestion[] = []

  for (const row of rows) {
    let pageImageKey: string | null = null

    if (row.pageId) {
      const key = imageKeyFor.get(row.pageId)
      if (key) pageImageKey = key
    }

    let rowChoices = byQuestion.get(row.id)
    if (!rowChoices) rowChoices = []

    unsolved.push({
      id: row.id,
      promptText: row.promptText,
      printedNumber: row.printedNumber,
      pageId: row.pageId,
      pageImageKey: pageImageKey,
      choices: rowChoices,
    })
  }

  return unsolved
}

function storedProviderName(name: string) {
  if (name === 'anthropic') return 'anthropic'
  if (name === 'openai') return 'openai'
  if (name === 'openrouter') return 'openrouter'
  if (name === 'google') return 'google'
  if (name === 'ollama') return 'ollama'

  return null
}

function storedAnswer(answer: string, choices: {label: string; text: string}[]) {
  const trimmed = answer.trim()
  if (!trimmed) return null

  if (choices.length === 0) return trimmed.slice(0, 200)

  const label = normalizeChoiceLabel(trimmed).toLowerCase()

  for (const choice of choices) {
    if (choice.label.toLowerCase() === label) return choice.label
  }

  const wanted = trimmed.toLowerCase()

  for (const choice of choices) {
    if (choice.text.trim().toLowerCase() === wanted) return choice.label
  }

  return null
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
) {
  if (input.answer === null) return false
  if (input.answerSource !== 'none') return false
  if (input.confidence < PROMOTE_ABOVE) return false

  const stored = storedAnswer(input.answer, input.choices)
  if (!stored) return false

  const updated = await db
    .update(questions)
    .set({correctAnswer: stored, answerSource: 'ai_derived'})
    .where(and(eq(questions.id, input.questionId), eq(questions.answerSource, 'none')))
    .returning({id: questions.id})

  return updated.length > 0
}

export type SolutionProgress = {
  solved: number
  promoted: number
  refused: number
  failed: number
}

export async function deriveSolutions(
  db: Db,
  provider: AIProvider,
  worksheetId: string,
  limit = 500,
): Promise<SolutionProgress> {
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
    .limit(limit)

  if (pending.length === 0) return progress

  for (const question of pending) {
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
        progress.refused = progress.refused + 1
        continue
      }

      progress.solved = progress.solved + 1

      const promoted = await promoteDerivedAnswer(db, {
        questionId: question.id,
        answer: solution.answer,
        confidence: solution.confidence,
        choices,
        answerSource: question.answerSource,
      })

      if (promoted) progress.promoted = progress.promoted + 1
    } catch (error) {
      progress.failed = progress.failed + 1

      console.log(
        '[solutions] question ' +
          question.id +
          ' could not be solved: ' +
          (error as Error).message,
      )
    }
  }

  console.log(
    '[solutions] ' +
      worksheetId +
      ': ' +
      progress.solved +
      ' solved, ' +
      progress.promoted +
      ' promoted, ' +
      progress.refused +
      ' declined, ' +
      progress.failed +
      ' failed',
  )

  return progress
}

export type ExplainInput = {
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

  let studentAnswer: string | null = null

  if (lastAttempt) {
    for (const choice of choices) {
      if (choice.id === lastAttempt.selectedChoiceId) {
        studentAnswer = choice.label
        break
      }
    }

    if (studentAnswer === null && lastAttempt.freeTextAnswer) {
      studentAnswer = lastAttempt.freeTextAnswer
    }
  }

  let correctAnswer = question.correctAnswer

  for (const choice of choices) {
    if (choice.isCorrect) {
      correctAnswer = choice.label
      break
    }
  }

  const plainChoices = []
  for (const choice of choices) {
    plainChoices.push({label: choice.label, text: choice.text})
  }

  let attemptId: string | null = null
  if (lastAttempt) attemptId = lastAttempt.id

  return {
    questionId: question.id,
    attemptId: attemptId,
    promptText: question.promptText,
    choices: plainChoices,
    correctAnswer: correctAnswer,
    studentAnswer: studentAnswer,
  }
}

export type ReviewableQuestion = ValidatableQuestion & {
  id: string
  pageNumber: number
}

export type Suspect = {
  id: string
  pageNumber: number
  printedNumber: number | null
  reasons: string[]
}

export type ReviewPlan = {
  suspects: Suspect[]
  reread: {pageNumber: number; expect: number[]}[]
  skippedPages: number[]
  modelConsulted: boolean
}

export type ReviewFn = (candidates: ReviewCandidate[]) => Promise<QuestionReview[]>

export type DoubtedQuestion = {
  id: string
  printedNumber: number | null
}

export type PageReplacement<T> = {
  replace: DoubtedQuestion[]
  keep: DoubtedQuestion[]
  replacements: T[]
}

export function planPageReplacement<T extends {ordinal: number; prompt_text: string}>(
  pageText: string,
  fresh: readonly T[],
  doubted: readonly DoubtedQuestion[],
): PageReplacement<T> {
  const prompts: string[] = []
  for (const question of fresh) prompts.push(question.prompt_text)

  const fromPage = printedNumbersFor(pageText, prompts)

  const numbers: (number | null)[] = []

  for (let index = 0; index < fresh.length; index++) {
    if (fromPage[index] !== null) {
      numbers.push(fromPage[index])
      continue
    }

    const counted = fresh[index].ordinal
    if (counted >= 1) numbers.push(counted)
    else numbers.push(null)
  }

  const refound = new Set<number>()
  for (const number of numbers) {
    if (number !== null) refound.add(number)
  }

  const replace: DoubtedQuestion[] = []
  const keep: DoubtedQuestion[] = []

  for (const row of doubted) {
    if (row.printedNumber !== null && refound.has(row.printedNumber)) replace.push(row)
    else keep.push(row)
  }

  const wanted = new Set<number>()
  for (const row of replace) {
    if (row.printedNumber !== null) wanted.add(row.printedNumber)
  }

  const replacements: T[] = []

  for (let index = 0; index < fresh.length; index++) {
    const number = numbers[index]
    if (number !== null && wanted.has(number)) replacements.push(fresh[index])
  }

  return {replace, keep, replacements}
}

export const MAX_REREAD_SHARE = 0.3

export async function planReview(
  questions: ReviewableQuestion[],
  review?: ReviewFn,
  maxRereadShare = MAX_REREAD_SHARE,
): Promise<ReviewPlan> {
  const expectedChoiceCount = modalChoiceCount(questions)

  const suspects = new Map<string, Suspect>()

  function flag(question: ReviewableQuestion, reason: string) {
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
    if (!worthRereading(flags)) continue

    for (const found of flags) flag(question, found.detail)
  }

  const unreviewed: ReviewableQuestion[] = []
  for (const question of questions) {
    if (suspects.has(question.id)) continue
    if (question.printedNumber === null) continue

    unreviewed.push(question)
  }

  let modelConsulted = false

  if (review && unreviewed.length > 0) {
    const byPage = new Map<number, ReviewableQuestion[]>()

    for (const question of unreviewed) {
      let onPage = byPage.get(question.pageNumber)

      if (!onPage) {
        onPage = []
        byPage.set(question.pageNumber, onPage)
      }

      onPage.push(question)
    }

    const pageNumbers = Array.from(byPage.keys())
    pageNumbers.sort(function (a, b) {
      return a - b
    })

    for (const pageNumber of pageNumbers) {
      const batch = byPage.get(pageNumber)
      if (!batch) continue

      try {
        const candidates: ReviewCandidate[] = []

        for (const question of batch) {
          candidates.push({
            number: question.printedNumber as number,
            prompt_text: question.promptText,
            choices: question.choices,
          })
        }

        const verdicts = await review(candidates)

        modelConsulted = true

        const byNumber = new Map<number | null, ReviewableQuestion>()
        for (const question of batch) byNumber.set(question.printedNumber, question)

        for (const verdict of verdicts) {
          if (verdict.intact) continue

          const question = byNumber.get(verdict.number)
          if (!question) continue

          let reason = 'the reviewer called it damaged'
          if (verdict.reason) reason = verdict.reason

          flag(question, reason)
        }
      } catch (error) {
        console.error('[review] could not review a page, continuing:', error)
      }
    }
  }

  const pages = new Set<number>()
  for (const question of questions) pages.add(question.pageNumber)

  let cap = Math.ceil(pages.size * maxRereadShare)
  if (cap < 1) cap = 1

  const numbersByPage = new Map<number, number[]>()

  for (const suspect of suspects.values()) {
    if (suspect.printedNumber === null) continue

    let onPage = numbersByPage.get(suspect.pageNumber)

    if (!onPage) {
      onPage = []
      numbersByPage.set(suspect.pageNumber, onPage)
    }

    onPage.push(suspect.printedNumber)
  }

  const ordered: {pageNumber: number; expect: number[]}[] = []

  for (const [pageNumber, numbers] of numbersByPage) {
    const expect: number[] = []
    for (const number of new Set(numbers)) expect.push(number)

    expect.sort(function (a, b) {
      return a - b
    })

    ordered.push({pageNumber, expect})
  }

  ordered.sort(function (a, b) {
    if (a.expect.length !== b.expect.length) return b.expect.length - a.expect.length
    return a.pageNumber - b.pageNumber
  })

  const reread = ordered.slice(0, cap)
  reread.sort(function (a, b) {
    return a.pageNumber - b.pageNumber
  })

  const skippedPages: number[] = []
  for (const page of ordered.slice(cap)) skippedPages.push(page.pageNumber)

  skippedPages.sort(function (a, b) {
    return a - b
  })

  const listed: Suspect[] = []
  for (const suspect of suspects.values()) listed.push(suspect)

  listed.sort(function (a, b) {
    if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber

    let left = a.printedNumber
    if (left === null) left = 0

    let right = b.printedNumber
    if (right === null) right = 0

    return left - right
  })

  return {suspects: listed, reread, skippedPages, modelConsulted}
}
