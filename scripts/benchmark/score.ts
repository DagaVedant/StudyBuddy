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

  expectedFrom: number
  expectedTotal: number

  found: number
  missed: number[]
  duplicated: number[]
  outOfRange: number[]

  countRecall: number

  rowsEmitted: number
  phantomPairs: number
  choicesComplete: number
  choicesIncomplete: number
  emptyStems: number
  schemaRejected: number

  totalWallMs: number
  msPerPage: number
  msPerQuestion: number
  tokensPerSec: number
  promptTokens: number
  evalTokens: number
}

export function scoreRun(
  model: string,
  runs: PageRun[],
  expectedTotal: number,
  offloaded: boolean,
  expectedFrom = 1,
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

      if (question.choices.length === 4) choicesComplete += 1
      else choicesIncomplete += 1

      const stem = normalizeForCompare(question.prompt_text)
      if (stem.length < 10) emptyStems += 1
      byPrompt.set(stem, (byPrompt.get(stem) ?? 0) + 1)
    }
  }

  const missed: number[] = []
  for (let n = expectedFrom; n <= expectedTotal; n += 1) {
    if (!counts.has(n)) missed.push(n)
  }

  const duplicated = [...counts.entries()]
    .filter(([n, c]) => c > 1 && n >= expectedFrom && n <= expectedTotal)
    .map(([n]) => n)
    .sort((a, b) => a - b)

  const outOfRange = [...counts.keys()]
    .filter((n) => n < expectedFrom || n > expectedTotal)
    .sort((a, b) => a - b)

  const phantomPairs = [...byPrompt.values()].filter((c) => c > 1).length

  const totalWallMs = runs.reduce((sum, r) => sum + r.wallMs, 0)
  const evalTokens = runs.reduce((sum, r) => sum + r.evalTokens, 0)
  const promptTokens = runs.reduce((sum, r) => sum + r.promptTokens, 0)
  const evalNs = runs.reduce((sum, r) => sum + r.evalDurationNs, 0)
  const pagesFailed = runs.filter((r) => r.error).length

  const inRange = Math.max(0, expectedTotal - expectedFrom + 1)
  const foundInRange = inRange - missed.length

  return {
    model,
    offloaded,
    pagesRun: runs.length,
    pagesFailed,
    expectedFrom,
    expectedTotal,
    found: foundInRange,
    missed,
    duplicated,
    outOfRange,
    countRecall: inRange > 0 ? foundInRange / inRange : 0,
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
