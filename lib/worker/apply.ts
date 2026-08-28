import {asc, eq, inArray} from 'drizzle-orm'

import {answerChoices, attempts, questions, reviewCards, worksheetPages, worksheets} from '@/lib/schema'
import {
  hashQuestion,
  normalizeChoiceLabel,
  normalizeForCompare,
  sortWithinPage,
} from '@/lib/questions/shape'
import {
  modalChoiceCount,
  parseCarriedChoices,
  planDuplicateMerges,
  planNumberDuplicateMerges,
  validateQuestion,
} from '@/lib/questions/numbering'
import {loadQuestionsWithChoices} from '@/lib/questions/queries'
import {refundTrial} from '@/lib/ai/resolve'
import {type Db} from '@/lib/db'
import {type JobStage, transitionWorksheet} from '@/lib/queue'

const RECOVERABLE = new Set(['multiple_choice', 'free_response'])

function fingerprint(choices: {text: string}[]) {
  const parts = []
  for (const choice of choices) parts.push(normalizeForCompare(choice.text))

  return parts.join('|')
}

export async function recoverCarriedChoices(db: Db, worksheetId: string) {
  const pages = await db
    .select({pageNumber: worksheetPages.pageNumber, ocrText: worksheetPages.ocrText})
    .from(worksheetPages)
    .where(eq(worksheetPages.worksheetId, worksheetId))
    .orderBy(asc(worksheetPages.pageNumber))

  if (pages.length < 2) return {recovered: 0}

  const rows = await loadQuestionsWithChoices(db, worksheetId)

  if (rows.length === 0) return {recovered: 0}

  const candidates = []
  for (const row of rows) candidates.push({...row, position: row.ordinal})

  const expectedCount = modalChoiceCount(candidates)

  const byPage = new Map<number, typeof candidates>()

  for (const candidate of candidates) {
    if (candidate.pageNumber === null) continue

    const onPage = byPage.get(candidate.pageNumber)
    if (onPage) onPage.push(candidate)
    else byPage.set(candidate.pageNumber, [candidate])
  }

  let recovered = 0

  for (const page of pages) {
    const previous = byPage.get(page.pageNumber - 1)
    if (!previous || previous.length === 0) continue

    const ordered = sortWithinPage(previous)
    const target = ordered[ordered.length - 1]

    if (!RECOVERABLE.has(target.questionType)) continue

    let hasEnough = target.choices.length > 0
    if (expectedCount !== null) hasEnough = target.choices.length >= expectedCount

    if (hasEnough) continue

    const held = []
    for (const choice of target.choices) held.push(choice.label)

    let ocrText = ''
    if (page.ocrText) ocrText = page.ocrText

    const carried = parseCarriedChoices(ocrText, {expectedCount, held})
    if (!carried) continue

    const codes = new Set<string>()

    const flags = validateQuestion({
      printedNumber: target.printedNumber,
      promptText: target.promptText,
      questionType: target.questionType,
      choices: target.choices,
    })

    for (const flag of flags) codes.add(flag.code)

    if (codes.has('stem_is_not_a_question') || codes.has('empty_stem')) continue

    let onThisPage = byPage.get(page.pageNumber)
    if (!onThisPage) onThisPage = []

    const first = sortWithinPage(onThisPage)[0]
    if (first && fingerprint(first.choices) === fingerprint(carried)) continue

    const newChoices = []
    for (const choice of carried) {
      newChoices.push({
        questionId: target.id,
        label: normalizeChoiceLabel(choice.label),
        text: choice.text,
        isCorrect: false,
      })
    }

    await db.insert(answerChoices).values(newChoices)

    const whole = []
    for (const choice of target.choices) whole.push(choice)
    for (const choice of carried) whole.push(choice)

    whole.sort(function (a, b) {
      return a.label.localeCompare(b.label)
    })

    const contentHash = hashQuestion(target.promptText, whole)

    await db
      .update(questions)
      .set({contentHash, questionType: 'multiple_choice'})
      .where(eq(questions.id, target.id))

    recovered = recovered + 1

    let shown = '?'
    if (target.printedNumber !== null) shown = String(target.printedNumber)

    console.log(
      '[carried] question ' +
        shown +
        ' took ' +
        carried.length +
        ' option(s) off page ' +
        page.pageNumber +
        ' on ' +
        worksheetId,
    )
  }

  return {recovered}
}

export async function mergeDuplicateQuestions(db: Db, worksheetId: string) {
  const rows = await loadQuestionsWithChoices(db, worksheetId)

  if (rows.length < 2) return {merged: 0}

  const candidates = []
  for (const row of rows) {
    candidates.push({
      id: row.id,
      printedNumber: row.printedNumber,
      promptText: row.promptText,
      choices: row.choices,
    })
  }

  const shaped = []
  for (const candidate of candidates) {
    shaped.push({
      printedNumber: candidate.printedNumber,
      promptText: candidate.promptText,
      questionType: 'multiple_choice',
      choices: candidate.choices,
    })
  }

  let expectedChoices = 4
  const modal = modalChoiceCount(shaped)
  if (modal !== null) expectedChoices = modal

  const plans = []
  for (const plan of planDuplicateMerges(candidates)) plans.push(plan)
  for (const plan of planNumberDuplicateMerges(candidates, expectedChoices)) plans.push(plan)

  const dropIds = []
  for (const plan of plans) dropIds.push(plan.dropId)

  const deletable = new Set(await deletableQuestionIds(db, dropIds))

  let merged = 0

  const holderOf = new Map<string, number>()
  const rowsWithNumber = new Map<number, Set<string>>()

  for (const candidate of candidates) {
    if (typeof candidate.printedNumber !== 'number') continue

    holderOf.set(candidate.id, candidate.printedNumber)

    let holders = rowsWithNumber.get(candidate.printedNumber)
    if (!holders) {
      holders = new Set<string>()
      rowsWithNumber.set(candidate.printedNumber, holders)
    }

    holders.add(candidate.id)
  }

  const gone = new Set<string>()

  for (const plan of plans) {
    if (gone.has(plan.dropId) || gone.has(plan.keepId)) {
      console.log(
        '[dedupe] skipped a plan on ' +
          worksheetId +
          ': an earlier merge already moved one of its rows',
      )
      continue
    }

    if (!deletable.has(plan.dropId)) {
      console.log(
        '[dedupe] kept ' + plan.dropId + ' on ' + worksheetId + ': a student has work against it',
      )
      continue
    }

    if (plan.printedNumber !== null) {
      let holders = rowsWithNumber.get(plan.printedNumber)
      if (!holders) holders = new Set<string>()

      let others = 0
      for (const id of holders) {
        if (id !== plan.keepId && id !== plan.dropId) others = others + 1
      }

      if (others > 0) {
        console.log(
          '[dedupe] kept ' +
            plan.dropId +
            ' on ' +
            worksheetId +
            ': number ' +
            plan.printedNumber +
            ' is already held by another row on this worksheet',
        )
        continue
      }

      await db
        .update(questions)
        .set({printedNumber: plan.printedNumber})
        .where(eq(questions.id, plan.keepId))

      const keptOldNumber = holderOf.get(plan.keepId)
      if (typeof keptOldNumber === 'number') {
        const previous = rowsWithNumber.get(keptOldNumber)
        if (previous) previous.delete(plan.keepId)
      }

      const droppedOldNumber = holderOf.get(plan.dropId)
      if (typeof droppedOldNumber === 'number') {
        const previous = rowsWithNumber.get(droppedOldNumber)
        if (previous) previous.delete(plan.dropId)
      }

      let newHolders = rowsWithNumber.get(plan.printedNumber)
      if (!newHolders) {
        newHolders = new Set<string>()
        rowsWithNumber.set(plan.printedNumber, newHolders)
      }

      newHolders.add(plan.keepId)
      holderOf.set(plan.keepId, plan.printedNumber)
      holderOf.delete(plan.dropId)
    }

    await db.delete(questions).where(eq(questions.id, plan.dropId))
    gone.add(plan.dropId)
    merged = merged + 1
  }

  return {merged}
}

export async function deletableQuestionIds(db: Db, ids: string[]) {
  if (ids.length === 0) return []

  const [claimedByAttempt, claimedByCard] = await Promise.all([
    db
      .select({id: attempts.questionId})
      .from(attempts)
      .where(inArray(attempts.questionId, ids)),
    db
      .select({id: reviewCards.questionId})
      .from(reviewCards)
      .where(inArray(reviewCards.questionId, ids)),
  ])

  const claimed = new Set<string>()
  for (const row of claimedByAttempt) claimed.add(row.id)
  for (const row of claimedByCard) claimed.add(row.id)

  const free: string[] = []
  for (const id of ids) {
    if (!claimed.has(id)) free.push(id)
  }

  return free
}

export async function partitionByDeletability<T extends {id: string}>(db: Db, rows: T[]) {
  const ids = []
  for (const row of rows) ids.push(row.id)

  const removableIds = new Set(await deletableQuestionIds(db, ids))

  const removable: T[] = []
  const held: T[] = []

  for (const row of rows) {
    if (removableIds.has(row.id)) removable.push(row)
    else held.push(row)
  }

  return {removable, held}
}

const READING_SHARE = 0.8
export const VERIFYING_AT = 0.8
export const CLASSIFYING_AT = 0.95

export type JobPhase = 'reading' | 'verifying' | 'classifying'

export function readingProgress(pageNumber: number, totalPages: number) {
  if (totalPages <= 0) return 0

  return (pageNumber / totalPages) * READING_SHARE
}

export function phaseFor(progress: number): JobPhase {
  if (progress >= CLASSIFYING_AT) return 'classifying'
  if (progress >= VERIFYING_AT) return 'verifying'

  return 'reading'
}

export const UNTAGGED_REASON = {
  classifierFailed:
    'Topic classification failed while this worksheet was processed, so no topics were assigned.',
  browserPending:
    'These questions are not sorted into topics yet. The model that sorts them cannot run on our server, so it runs in your browser instead, on this screen.',
  workerQueued:
    'These questions are not sorted into topics yet. The model that sorts them cannot run on our server, so they are queued for the machine that runs it. Sorting them here instead keeps them on your own machine, and is quicker.',
} as const

type UntaggedReason = (typeof UNTAGGED_REASON)[keyof typeof UNTAGGED_REASON]

export async function recordUntagged(
  db: Db,
  worksheetId: string,
  reason: UntaggedReason,
) {
  await db
    .update(worksheets)
    .set({classificationError: reason})
    .where(eq(worksheets.id, worksheetId))
}

export async function clearUntagged(db: Db, worksheetId: string) {
  await db
    .update(worksheets)
    .set({classificationError: null})
    .where(eq(worksheets.id, worksheetId))
}

export type FailedJob = {
  stage: JobStage
  userId: string
  worksheetId: string
}

export async function applyPermanentFailure(db: Db, job: FailedJob) {
  if (job.stage === 'explain') {
    await refundTrial(db, job.userId, 'explanations', 1)
    return
  }

  if (job.stage === 'classify') {
    await recordUntagged(db, job.worksheetId, UNTAGGED_REASON.browserPending)
    return
  }

  if (job.stage === 'extract') {
    const [worksheet] = await db
      .select({tierUsed: worksheets.tierUsed})
      .from(worksheets)
      .where(eq(worksheets.id, job.worksheetId))
      .limit(1)

    if (worksheet && worksheet.tierUsed === 'trial') {
      await refundTrial(db, job.userId, 'worksheets', 1)
    }

    await transitionWorksheet(db, job.worksheetId, ['queued', 'processing'], {
      status: 'failed',
    })
  }
}
