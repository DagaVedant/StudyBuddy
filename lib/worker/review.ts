import type { QuestionReview, ReviewCandidate } from '@/lib/ai/types'
import { printedNumbersFor } from '@/lib/questions/printed-numbers'
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
  /** Pages to hand back to the vision model, worst first. */
  reread: { pageNumber: number; expect: number[] }[]
  /** Pages left out because the cap was reached. */
  skippedPages: number[]
  modelConsulted: boolean
}

export type ReviewFn = (candidates: ReviewCandidate[]) => Promise<QuestionReview[]>

/** A stored question the review doubted, as the write path sees it. */
export interface DoubtedQuestion {
  id: string
  printedNumber: number | null
}

export interface PageReplacement<T> {
  /** Rows to delete, because the second read returned their number. */
  replace: DoubtedQuestion[]
  /** Rows to leave alone, because it did not. */
  keep: DoubtedQuestion[]
  /** The fresh questions that stand in for the deleted rows. */
  replacements: T[]
}

/**
 * What a page's second read is allowed to overwrite.
 *
 * Split out of the route because it decides deletions, and a rule about
 * deleting a student's questions should be readable and testable on its own.
 *
 * Both sides are numbered off the page, the same way the write path numbers
 * what it stores. Matching on the model's own count only works while the
 * re-read happens to count from where the paper does: a page read on its own
 * counts from 1, so on page 2 every number would miss every doubted row, and
 * the review would silently do nothing at all.
 *
 * A doubted row whose number does not come back is kept. Turning a question
 * that is merely damaged into one that is missing is strictly worse, and the
 * student can fix damaged; they cannot fix absent.
 */
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

  // Only what stands in for something deleted. Writing the whole page back
  // looked harmless because the write path skips a hash it already has, but a
  // second read rarely reproduces a page character for character, so every
  // re-read quietly added a second copy of questions never in doubt.
  const wanted = new Set(
    replace.map((row) => row.printedNumber).filter((n): n is number => n !== null),
  )

  const replacements = fresh.filter((_, index) => {
    const number = numberAt(index)
    return number !== null && wanted.has(number)
  })

  return { replace, keep, replacements }
}

/**
 * Share of the worksheet's pages that may be re-read.
 *
 * Re-reading costs about as much as the first pass did, so a run where most
 * questions look wrong must not quietly double the job. Past this point the
 * problem is the extraction as a whole, and the student is better served by
 * reaching the review screen and seeing it than by waiting twice as long for
 * the same model to make the same mistakes.
 */
const MAX_REREAD_SHARE = 0.3

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

  // Only questions the cheap checks cleared are worth a model's time, and only
  // numbered ones, since the verdict points back by printed number.
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
        // The questions are already saved; a reviewer that errors costs a
        // second opinion, not the upload.
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

  // Worst pages first, so the cap spends its budget where the most is wrong.
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
