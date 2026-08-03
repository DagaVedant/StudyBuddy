import type { ExtractedQuestion } from '../../lib/ai/types'
import { normalizeForCompare } from '../../lib/questions/shape'

export interface PageRun {
  pageNumber: number
  questions: ExtractedQuestion[]
  rejected: number
  wallMs: number
  promptTokens: number
  evalTokens: number
  evalDurationNs: number
  loadDurationNs: number
  error?: string
}

export interface ModelScore {
  model: string
  offloaded: boolean

  pagesRun: number
  pagesFailed: number

  // Coverage, measured against printed numbers 1..expectedTotal.
  found: number
  missed: number[]
  duplicated: number[]
  outOfRange: number[]

  countRecall: number

  // Fidelity.
  rowsEmitted: number
  phantomPairs: number
  choicesComplete: number
  choicesIncomplete: number
  emptyStems: number
  schemaRejected: number

  // Cost.
  totalWallMs: number
  msPerPage: number
  msPerQuestion: number
  tokensPerSec: number
  promptTokens: number
  evalTokens: number
}

/**
 * Scores one model's run.
 *
 * Coverage is graded against the printed numbers rather than a hand-labelled
 * key: every number in 1..expectedTotal should appear exactly once across the
 * paper, which makes the sequence its own ground truth and keeps the whole
 * page range gradeable without labelling 56 pages by hand.
 */
export function scoreRun(
  model: string,
  runs: PageRun[],
  expectedTotal: number,
  offloaded: boolean,
): ModelScore {
  const counts = new Map<number, number>()
  let rowsEmitted = 0
  let choicesComplete = 0
  let choicesIncomplete = 0
  let emptyStems = 0
  let schemaRejected = 0

  const byPrompt = new Map<string, number>()

  for (const run of runs) {
    schemaRejected += run.rejected

    for (const question of run.questions) {
      rowsEmitted += 1

      const n = question.ordinal
      if (Number.isInteger(n) && n >= 1) counts.set(n, (counts.get(n) ?? 0) + 1)

      // Every question on this paper is multiple choice with four options, so
      // anything short of that lost content the extractor could see.
      if (question.choices.length === 4) choicesComplete += 1
      else choicesIncomplete += 1

      const stem = normalizeForCompare(question.prompt_text)
      if (stem.length < 10) emptyStems += 1
      byPrompt.set(stem, (byPrompt.get(stem) ?? 0) + 1)
    }
  }

  const missed: number[] = []
  for (let n = 1; n <= expectedTotal; n += 1) if (!counts.has(n)) missed.push(n)

  const duplicated = [...counts.entries()]
    .filter(([n, c]) => c > 1 && n <= expectedTotal)
    .map(([n]) => n)
    .sort((a, b) => a - b)

  const outOfRange = [...counts.keys()]
    .filter((n) => n > expectedTotal)
    .sort((a, b) => a - b)

  const phantomPairs = [...byPrompt.values()].filter((c) => c > 1).length

  const totalWallMs = runs.reduce((sum, r) => sum + r.wallMs, 0)
  const evalTokens = runs.reduce((sum, r) => sum + r.evalTokens, 0)
  const promptTokens = runs.reduce((sum, r) => sum + r.promptTokens, 0)
  const evalNs = runs.reduce((sum, r) => sum + r.evalDurationNs, 0)
  const pagesFailed = runs.filter((r) => r.error).length

  const foundInRange = expectedTotal - missed.length

  return {
    model,
    offloaded,
    pagesRun: runs.length,
    pagesFailed,
    found: foundInRange,
    missed,
    duplicated,
    outOfRange,
    countRecall: expectedTotal > 0 ? foundInRange / expectedTotal : 0,
    rowsEmitted,
    phantomPairs,
    choicesComplete,
    choicesIncomplete,
    emptyStems,
    schemaRejected,
    totalWallMs,
    msPerPage: runs.length > 0 ? totalWallMs / runs.length : 0,
    msPerQuestion: rowsEmitted > 0 ? totalWallMs / rowsEmitted : 0,
    tokensPerSec: evalNs > 0 ? evalTokens / (evalNs / 1e9) : 0,
    promptTokens,
    evalTokens,
  }
}
