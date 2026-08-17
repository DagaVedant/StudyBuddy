import type { QuestionReview, ReviewCandidate } from '@/lib/ai/types'
import { printedNumbersFor } from '@/lib/questions/numbering'
import {
  modalChoiceCount,
  validateQuestion,
  worthRereading,
  type ValidatableQuestion,
} from '@/lib/questions/validate'

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
  reread: { pageNumber: number; expect: number[] }[]
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

export function planPageReplacement<T extends { ordinal: number; prompt_text: string }>(
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

  return { replace, keep, replacements }
}

export const MAX_REREAD_SHARE = 0.3

export async function planReview(
  questions: ReviewableQuestion[],
  review?: ReviewFn,
  options: { maxRereadShare?: number } = {},
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
    const flags = validateQuestion(question, { expectedChoiceCount })
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
