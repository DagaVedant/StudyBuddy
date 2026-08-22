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

export async function recoverCarriedChoices(
  db: Db,
  worksheetId: string,
): Promise<{recovered: number}> {
  const pages = await db
    .select({pageNumber: worksheetPages.pageNumber, ocrText: worksheetPages.ocrText})
    .from(worksheetPages)
    .where(eq(worksheetPages.worksheetId, worksheetId))
    .orderBy(asc(worksheetPages.pageNumber))

  if (pages.length < 2) return {recovered: 0}

  const rows = await loadQuestionsWithChoices(db, worksheetId)

  if (rows.length === 0) return {recovered: 0}

  const candidates = rows.map((row) => ({...row, position: row.ordinal}))

  const expectedCount = modalChoiceCount(candidates)

  const byPage = new Map<number, typeof candidates>()
  for (const candidate of candidates) {
    if (candidate.pageNumber === null) continue
    const onPage = byPage.get(candidate.pageNumber)
    if (onPage) onPage.push(candidate)
    else byPage.set(candidate.pageNumber, [candidate])
  }

  const fingerprint = (choices: {text: string}[]): string =>
    choices.map((choice) => normalizeForCompare(choice.text)).join('|')

  let recovered = 0

  for (const page of pages) {
    const previous = byPage.get(page.pageNumber - 1)
    if (!previous || previous.length === 0) continue

    const ordered = sortWithinPage(previous)
    const target = ordered[ordered.length - 1]

    if (!RECOVERABLE.has(target.questionType)) continue

    const hasEnough =
      expectedCount === null
        ? target.choices.length > 0
        : target.choices.length >= expectedCount
    if (hasEnough) continue

    const held = target.choices.map((choice) => choice.label)

    const carried = parseCarriedChoices(page.ocrText ?? '', {expectedCount, held})
    if (!carried) continue

    const codes = new Set(
      validateQuestion({
        printedNumber: target.printedNumber,
        promptText: target.promptText,
        questionType: target.questionType,
        choices: target.choices,
      }).map((flag) => flag.code),
    )
    if (codes.has('stem_is_not_a_question') || codes.has('empty_stem')) continue

    const first = sortWithinPage(byPage.get(page.pageNumber) ?? [])[0]
    if (first && fingerprint(first.choices) === fingerprint(carried)) continue

    await db.insert(answerChoices).values(
      carried.map((choice) => ({
        questionId: target.id,
        label: normalizeChoiceLabel(choice.label),
        text: choice.text,
        isCorrect: false,
      })),
    )

    const whole = [...target.choices, ...carried].sort((a, b) =>
      a.label.localeCompare(b.label),
    )
    const contentHash = hashQuestion(target.promptText, whole)

    await db
      .update(questions)
      .set({contentHash, questionType: 'multiple_choice'})
      .where(eq(questions.id, target.id))

    recovered += 1
    console.log(
      `[carried] question ${target.printedNumber ?? '?'} took ${carried.length} option(s) ` +
        `off page ${page.pageNumber} on ${worksheetId}`,
    )
  }

  return {recovered}
}

export async function mergeDuplicateQuestions(
  db: Db,
  worksheetId: string,
): Promise<{merged: number}> {
  const rows = await loadQuestionsWithChoices(db, worksheetId)

  if (rows.length < 2) return {merged: 0}

  const candidates = rows.map((row) => ({
    id: row.id,
    printedNumber: row.printedNumber,
    promptText: row.promptText,
    choices: row.choices,
  }))

  const expectedChoices =
    modalChoiceCount(
      candidates.map((c) => ({
        printedNumber: c.printedNumber,
        promptText: c.promptText,
        questionType: 'multiple_choice',
        choices: c.choices,
      })),
    ) ?? 4

  const plans = [
    ...planDuplicateMerges(candidates),
    ...planNumberDuplicateMerges(candidates, expectedChoices),
  ]

  const deletable = new Set(
    await deletableQuestionIds(
      db,
      plans.map((plan) => plan.dropId),
    ),
  )

  let merged = 0

  const holderOf = new Map<string, number>()
  const rowsWithNumber = new Map<number, Set<string>>()

  for (const candidate of candidates) {
    if (typeof candidate.printedNumber !== 'number') continue
    holderOf.set(candidate.id, candidate.printedNumber)
    const holders = rowsWithNumber.get(candidate.printedNumber) ?? new Set<string>()
    holders.add(candidate.id)
    rowsWithNumber.set(candidate.printedNumber, holders)
  }

  const gone = new Set<string>()

  for (const plan of plans) {
    if (gone.has(plan.dropId) || gone.has(plan.keepId)) {
      console.log(
        `[dedupe] skipped a plan on ${worksheetId}: an earlier merge already ` +
          `moved one of its rows`,
      )
      continue
    }

    if (!deletable.has(plan.dropId)) {
      console.log(
        `[dedupe] kept ${plan.dropId} on ${worksheetId}: a student has work against it`,
      )
      continue
    }

    if (plan.printedNumber !== null) {
      const holders = rowsWithNumber.get(plan.printedNumber) ?? new Set<string>()
      const others = [...holders].filter(
        (id) => id !== plan.keepId && id !== plan.dropId,
      )

      if (others.length > 0) {
        console.log(
          `[dedupe] kept ${plan.dropId} on ${worksheetId}: number ` +
            `${plan.printedNumber} is already held by another row on this worksheet`,
        )
        continue
      }

      await db
        .update(questions)
        .set({printedNumber: plan.printedNumber})
        .where(eq(questions.id, plan.keepId))

      const keptOldNumber = holderOf.get(plan.keepId)
      if (typeof keptOldNumber === 'number') {
        rowsWithNumber.get(keptOldNumber)?.delete(plan.keepId)
      }
      const droppedOldNumber = holderOf.get(plan.dropId)
      if (typeof droppedOldNumber === 'number') {
        rowsWithNumber.get(droppedOldNumber)?.delete(plan.dropId)
      }

      const newHolders = rowsWithNumber.get(plan.printedNumber) ?? new Set<string>()
      newHolders.add(plan.keepId)
      rowsWithNumber.set(plan.printedNumber, newHolders)
      holderOf.set(plan.keepId, plan.printedNumber)
      holderOf.delete(plan.dropId)
    }

    await db.delete(questions).where(eq(questions.id, plan.dropId))
    gone.add(plan.dropId)
    merged += 1
  }

  return {merged}
}

export async function partitionByDeletability<T extends {id: string}>(
  db: Db,
  rows: T[],
): Promise<{removable: T[]; held: T[]}> {
  const removableIds = new Set(
    await deletableQuestionIds(
      db,
      rows.map((row) => row.id),
    ),
  )

  return {
    removable: rows.filter((row) => removableIds.has(row.id)),
    held: rows.filter((row) => !removableIds.has(row.id)),
  }
}

export async function deletableQuestionIds(db: Db, ids: string[]): Promise<string[]> {
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

  const claimed = new Set([
    ...claimedByAttempt.map((row) => row.id),
    ...claimedByCard.map((row) => row.id),
  ])

  return ids.filter((id) => !claimed.has(id))
}

const READING_SHARE = 0.8
export const VERIFYING_AT = 0.8
export const CLASSIFYING_AT = 0.95

export type JobPhase = 'reading' | 'verifying' | 'classifying'

export function readingProgress(pageNumber: number, totalPages: number): number {
  if (totalPages <= 0) return 0
  return (pageNumber / totalPages) * READING_SHARE
}

export function phaseFor(progress: number): JobPhase {
  if (progress >= CLASSIFYING_AT) return 'classifying'
  if (progress >= VERIFYING_AT) return 'verifying'
  return 'reading'
}

export interface FailedJob {
  stage: JobStage
  userId: string
  worksheetId: string
}

export async function applyPermanentFailure(db: Db, job: FailedJob): Promise<void> {
  switch (job.stage) {
    case 'explain':
      await refundTrial(db, job.userId, 'explanations', 1)
      return

    case 'answer_key':
      return

    case 'classify':
      await recordUntagged(db, job.worksheetId, UNTAGGED_REASON.browserPending)
      return

    case 'extract': {
      const [worksheet] = await db
        .select({tierUsed: worksheets.tierUsed})
        .from(worksheets)
        .where(eq(worksheets.id, job.worksheetId))
        .limit(1)

      if (worksheet?.tierUsed === 'trial') {
        await refundTrial(db, job.userId, 'worksheets', 1)
      }

      await transitionWorksheet(db, job.worksheetId, ['queued', 'processing'], {
        status: 'failed',
      })

      return
    }
  }
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
): Promise<void> {
  await db
    .update(worksheets)
    .set({classificationError: reason})
    .where(eq(worksheets.id, worksheetId))
}

export async function clearUntagged(db: Db, worksheetId: string): Promise<void> {
  await db
    .update(worksheets)
    .set({classificationError: null})
    .where(eq(worksheets.id, worksheetId))
}
