import {and, asc, eq, ne, sql} from 'drizzle-orm'

import {
  answerChoices,
  questions,
  worksheetPages,
  worksheets,
} from '@/lib/db/schema'
import {
  deletableQuestionIds,
  mergeDuplicateQuestions,
  recoverCarriedChoices,
} from '@/lib/worker/apply'
import {
  modalChoiceCount,
  planPageSplitJoins,
  type SplitHalf,
} from '@/lib/questions/validate'
import {duplicatePrintedNumbers} from '@/lib/questions/numbering'
import {hashQuestion, normalizeChoiceLabel} from '@/lib/questions/shape'
import {inferPrintedNumbers} from '@/lib/questions/numbering'
import {loadQuestionsWithChoices} from '@/lib/questions/queries'
import {mergeAnswerKeys, parseAnswerKey} from '@/lib/questions/text'
import {normalizeMath} from '@/lib/questions/shape'
import {type Db} from '@/lib/db'

const ORDER = [
  'join',
  'carried',
  'math',
  'numbers',
  'merge',
  'renumber',
  'answers',
] as const

export type RepairPass = (typeof ORDER)[number]

export interface RepairCounts {
  joined: number
  recovered: number
  rendered: number
  repaired: number
  merged: number
  renumbered: number
  answered: number
  
  duplicateNumbers: number[]
}

const NONE: RepairCounts = {
  joined: 0,
  recovered: 0,
  rendered: 0,
  repaired: 0,
  merged: 0,
  renumbered: 0,
  answered: 0,
  duplicateNumbers: [],
}

export interface RepairOptions {
  
  only?: readonly RepairPass[]
  
  log?: string | null
}

export async function runRepairPasses(
  db: Db,
  worksheetId: string,
  options: RepairOptions = {},
): Promise<RepairCounts> {
  const wanted = new Set<RepairPass>(options.only ?? ORDER)
  const log = options.log === undefined ? '' : options.log
  
  const counts: RepairCounts = {...NONE, duplicateNumbers: []}

  const note = (message: string) => {
    if (log !== null) console.log(`${log}${message} on ${worksheetId}`)
  }

  for (const pass of ORDER) {
    if (!wanted.has(pass)) continue

    switch (pass) {
      case 'join': {
        const {joined} = await joinSplitQuestions(db, worksheetId)
        counts.joined = joined
        if (joined > 0) note(`[split] rejoined ${joined} question(s)`)
        break
      }
      case 'carried': {
        const {recovered} = await recoverCarriedChoices(db, worksheetId)
        counts.recovered = recovered
        if (recovered > 0) note(`[carried] recovered options for ${recovered} question(s)`)
        break
      }
      case 'math': {
        const {repaired} = await repairUnrenderedMath(db, worksheetId)
        counts.rendered = repaired
        if (repaired > 0) note(`[maths] re-rendered ${repaired} question(s)`)
        break
      }
      case 'numbers': {
        const {repaired} = await repairPrintedNumbers(db, worksheetId)
        counts.repaired = repaired
        if (repaired > 0) note(`[numbers] recovered ${repaired} printed number(s)`)
        break
      }
      case 'merge': {
        const {merged} = await mergeDuplicateQuestions(db, worksheetId)
        counts.merged = merged
        if (merged > 0) note(`[dedupe] folded ${merged} duplicate question(s)`)
        break
      }
      case 'renumber': {
        const {renumbered, duplicateNumbers} = await renumberQuestions(db, worksheetId)
        counts.renumbered = renumbered
        counts.duplicateNumbers = duplicateNumbers
        if (renumbered > 0) note(`[renumber] reordered ${renumbered} question(s)`)
        if (duplicateNumbers.length > 0) {
          note(`[renumber] printed number(s) claimed twice: ${duplicateNumbers.join(', ')}`)
        }
        break
      }
      case 'answers': {
        const {answered} = await applyAnswerKey(db, worksheetId)
        counts.answered = answered
        if (answered > 0) note(`[key] answered ${answered} question(s) from the paper`)
        break
      }
    }
  }

  return counts
}

export const VERIFYING_PASSES = ['join', 'carried', 'math', 'merge'] as const

export const FINAL_PASSES = ORDER

export async function applyAnswerKey(
  db: Db,
  worksheetId: string,
): Promise<{answered: number}> {
  const pages = await db
    .select({ocrText: worksheetPages.ocrText})
    .from(worksheetPages)
    .where(eq(worksheetPages.worksheetId, worksheetId))
    .orderBy(asc(worksheetPages.pageNumber))

  const key = mergeAnswerKeys(pages.map((page) => parseAnswerKey(page.ocrText ?? '')))
  if (key.size === 0) return {answered: 0}

  const rows = await db
    .select({
      id: questions.id,
      printedNumber: questions.printedNumber,
    })
    .from(questions)
    .where(
      and(
        eq(questions.worksheetId, worksheetId),
        ne(questions.answerSource, 'user_key'),
      ),
    )

  let answered = 0

  for (const row of rows) {
    if (row.printedNumber === null) continue

    const label = key.get(row.printedNumber)
    if (!label) continue

    await db
      .update(questions)
      .set({correctAnswer: label, answerSource: 'pdf_key'})
      .where(eq(questions.id, row.id))

    const choices = await db
      .select({
        id: answerChoices.id,
        label: answerChoices.label,
        isCorrect: answerChoices.isCorrect,
      })
      .from(answerChoices)
      .where(eq(answerChoices.questionId, row.id))

    for (const choice of choices) {
      const isCorrect = normalizeChoiceLabel(choice.label).toUpperCase() === label

      if (choice.isCorrect === isCorrect) continue
      await db
        .update(answerChoices)
        .set({isCorrect})
        .where(eq(answerChoices.id, choice.id))
    }

    answered += 1
  }

  return {answered}
}

export async function repairUnrenderedMath(
  db: Db,
  worksheetId: string,
): Promise<{repaired: number}> {
  const rows = await loadQuestionsWithChoices(db, worksheetId)

  if (rows.length === 0) return {repaired: 0}

  let repaired = 0

  for (const row of rows) {
    const choices = row.choices
    const promptText = normalizeMath(row.promptText)
    const fixedChoices = choices.map((choice) => ({
      ...choice,
      fixed: normalizeMath(choice.text),
    }))

    const changedChoices = fixedChoices.filter((choice) => choice.fixed !== choice.text)
    if (promptText === row.promptText && changedChoices.length === 0) continue

    for (const choice of changedChoices) {
      await db
        .update(answerChoices)
        .set({text: choice.fixed})
        .where(eq(answerChoices.id, choice.id))
    }

    const contentHash = hashQuestion(
      promptText,
      fixedChoices.map((choice) => ({text: choice.fixed})),
    )

    await db
      .update(questions)
      .set({promptText, contentHash})
      .where(eq(questions.id, row.id))

    repaired += 1
    console.log(`[maths] rewrote ${row.id} on ${worksheetId}: ${promptText.slice(0, 60)}`)
  }

  return {repaired}
}

export async function repairPrintedNumbers(
  db: Db,
  worksheetId: string,
): Promise<{repaired: number}> {
  const [sheet] = await db
    .select({expected: worksheets.expectedQuestionCount})
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  const rows = await db
    .select({
      id: questions.id,
      ordinal: questions.ordinal,
      printedNumber: questions.printedNumber,
      pageNumber: worksheetPages.pageNumber,
    })
    .from(questions)
    .leftJoin(worksheetPages, eq(worksheetPages.id, questions.pageId))
    .where(eq(questions.worksheetId, worksheetId))
    .orderBy(asc(questions.ordinal))

  if (rows.length === 0) return {repaired: 0}

  const fixes = inferPrintedNumbers(
    rows.map((row) => ({
      id: row.id,
      pageNumber: row.pageNumber,
      position: row.ordinal,
      printedNumber: row.printedNumber,
    })),
    sheet?.expected ?? null,
  )

  for (const fix of fixes) {
    await db
      .update(questions)
      .set({printedNumber: fix.to})
      .where(eq(questions.id, fix.id))

    console.log(
      `[numbers] ${fix.reason} on ${worksheetId}: ${fix.from ?? 'blank'} -> ${fix.to}`,
    )
  }

  return {repaired: fixes.length}
}

export async function renumberQuestions(
  db: Db,
  worksheetId: string,
): Promise<{renumbered: number; duplicateNumbers: number[]}> {
  const rows = await db
    .select({
      id: questions.id,
      ordinal: questions.ordinal,
      pageNumber: worksheetPages.pageNumber,
      printedNumber: questions.printedNumber,
    })
    .from(questions)
    .leftJoin(worksheetPages, eq(worksheetPages.id, questions.pageId))
    .where(eq(questions.worksheetId, worksheetId))
    .orderBy(asc(questions.ordinal))

  if (rows.length === 0) return {renumbered: 0, duplicateNumbers: []}

  const duplicateNumbers = duplicatePrintedNumbers(rows)

  const ordered = [...rows].sort((a, b) => {
    const pageA = a.pageNumber ?? Number.MAX_SAFE_INTEGER
    const pageB = b.pageNumber ?? Number.MAX_SAFE_INTEGER
    if (pageA !== pageB) return pageA - pageB

    const printedA = a.printedNumber ?? Number.MAX_SAFE_INTEGER
    const printedB = b.printedNumber ?? Number.MAX_SAFE_INTEGER
    if (printedA !== printedB) return printedA - printedB

    return a.ordinal - b.ordinal
  })

  const moved = ordered
    .map((row, index) => ({id: row.id, ordinal: index + 1}))
    .filter((row, index) => ordered[index].ordinal !== row.ordinal)

  if (moved.length > 0) {
    const values = sql.join(
      moved.map((row) => sql`(${row.id}, ${row.ordinal}::int)`),
      sql`, `,
    )

    await db.execute(sql`
      update ${questions} as q
      set ordinal = v.ordinal
      from (values ${values}) as v(id, ordinal)
      where q.id = v.id
    `)
  }

  const renumbered = moved.length

  return {renumbered, duplicateNumbers}
}

export async function joinSplitQuestions(
  db: Db,
  worksheetId: string,
): Promise<{joined: number}> {
  const rows = await loadQuestionsWithChoices(db, worksheetId)

  if (rows.length < 2) return {joined: 0}

  const candidates: SplitHalf[] = rows.map((row) => ({
    id: row.id,
    pageNumber: row.pageNumber,
    position: row.ordinal,
    top: row.top,
    printedNumber: row.printedNumber,
    promptText: row.promptText,
    questionType: row.questionType,
    choices: row.choices,
  }))

  const plans = planPageSplitJoins(candidates, {
    expectedChoiceCount: modalChoiceCount(candidates),
  })

  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]))

  const deletable = new Set(
    await deletableQuestionIds(
      db,
      plans.map((plan) => plan.dropId),
    ),
  )

  let joined = 0

  for (const plan of plans) {
    const keep = byId.get(plan.keepId)
    const drop = byId.get(plan.dropId)
    if (!keep || !drop) continue

    if (!deletable.has(plan.dropId)) {
      console.log(
        `[split] left ${plan.dropId} on ${worksheetId}: a student has work against it`,
      )
      continue
    }

    await db
      .update(answerChoices)
      .set({questionId: plan.keepId})
      .where(eq(answerChoices.questionId, plan.dropId))

    const contentHash = hashQuestion(keep.promptText, drop.choices)

    await db
      .update(questions)
      .set({printedNumber: plan.printedNumber, contentHash})
      .where(eq(questions.id, plan.keepId))

    await db.delete(questions).where(eq(questions.id, plan.dropId))
    joined += 1

    console.log(`[split] ${plan.reason} on ${worksheetId}`)
  }

  return {joined}
}

export interface PageFindings {
  pageNumber: number
  printed: number[]
  expectsQuestions?: boolean
}

export interface RetryTarget {
  pageNumber: number
  expect: number[]
}

export interface AuditResult {
  missing: number[]
  retry: RetryTarget[]
  found: number
  expected: number | null
  extra: number[]
  silent: number[]
}

export function auditExtraction(
  pages: PageFindings[],
  expectedTotal: number | null = null,
): AuditResult {
  const seen = new Set<number>()
  for (const page of pages) {
    for (const number of page.printed) {
      if (Number.isInteger(number) && number >= 1) seen.add(number)
    }
  }

  const hasNumbers = seen.size > 0
  const lowest = hasNumbers ? Math.min(...seen) : 1
  const highest = hasNumbers ? Math.max(...seen) : 0

  const ceiling =
    expectedTotal && expectedTotal > 0 && lowest === 1
      ? Math.max(expectedTotal, highest)
      : highest

  const missing: number[] = []
  for (let number = lowest; number <= ceiling; number += 1) {
    if (number >= 1 && !seen.has(number)) missing.push(number)
  }

  const expected = expectedTotal && expectedTotal > 0 ? expectedTotal : null

  const silent = pages
    .filter((page) => page.expectsQuestions === true && page.printed.length === 0)
    .map((page) => page.pageNumber)
    .sort((a, b) => a - b)

  const retry = pagesToRetry(pages, missing, silent)
  const targeted = new Set(retry.map((target) => target.pageNumber))

  for (const pageNumber of silent) {
    if (!targeted.has(pageNumber)) retry.push({pageNumber, expect: []})
  }

  return {
    missing,
    retry: retry.sort((a, b) => a.pageNumber - b.pageNumber),
    found: seen.size,
    expected,
    extra: expected ? [...seen].filter((n) => n > expected).sort((a, b) => a - b) : [],
    silent,
  }
}

function pagesToRetry(
  pages: PageFindings[],
  missing: number[],
  silent: number[],
): RetryTarget[] {
  if (missing.length === 0) return []

  const numbered = pages
    .filter((page) => page.printed.length > 0)
    .map((page) => ({
      pageNumber: page.pageNumber,
      low: Math.min(...page.printed),
      high: Math.max(...page.printed),
    }))
    .sort((a, b) => a.pageNumber - b.pageNumber)

  const expectByPage = new Map<number, Set<number>>()

  const add = (pageNumber: number, number: number) => {
    const set = expectByPage.get(pageNumber) ?? new Set<number>()
    set.add(number)
    expectByPage.set(pageNumber, set)
  }

  for (const number of missing) {
    const containing = numbered.filter((p) => number > p.low && number < p.high)
    if (containing.length > 0) {
      for (const page of containing) add(page.pageNumber, number)
      continue
    }

    const before = [...numbered].reverse().find((p) => p.high < number)
    const after = numbered.find((p) => p.low > number)

    const between = silent.filter(
      (pageNumber) =>
        (!before || pageNumber > before.pageNumber) &&
        (!after || pageNumber < after.pageNumber),
    )

    if (between.length > 0) {
      for (const pageNumber of between) add(pageNumber, number)
      continue
    }

    if (before) add(before.pageNumber, number)
    if (after) add(after.pageNumber, number)

    if (!before && !after) {
      for (const page of pages.filter((p) => p.printed.length === 0)) {
        add(page.pageNumber, number)
      }
    }
  }

  return [...expectByPage.entries()]
    .map(([pageNumber, expect]) => ({
      pageNumber,
      expect: [...expect].sort((a, b) => a - b),
    }))
    .sort((a, b) => a.pageNumber - b.pageNumber)
}
