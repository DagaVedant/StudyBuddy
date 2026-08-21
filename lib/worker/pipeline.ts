import {and, asc, eq, ne, sql} from 'drizzle-orm'

import {answerChoices, questions, worksheetPages, worksheets} from '@/lib/schema'
import {
  deletableQuestionIds,
  mergeDuplicateQuestions,
  recoverCarriedChoices,
} from '@/lib/worker/apply'
import {
  duplicatePrintedNumbers,
  inferPrintedNumbers,
  printedNumbersFor,
} from '@/lib/questions/numbering'
import {
  foldLeadInChoices,
  hashQuestion,
  normalizeChoiceLabel,
  normalizeForCompare,
  normalizeMath,
  normalizeOptionText,
} from '@/lib/questions/shape'
import {
  isAnswerPage,
  mergeAnswerKeys,
  parseAnswerKey,
  reflowText,
  seamAround,
} from '@/lib/questions/shape'
import {
  isOptionRun,
  modalChoiceCount,
  planPageSplitJoins,
  type SplitHalf,
} from '@/lib/questions/numbering'
import {checkpointJob} from '@/lib/queue'
import {loadQuestionsWithChoices} from '@/lib/questions/queries'
import {storage} from '@/lib/queue'
import {type AIProvider, type ExtractedQuestion} from '@/lib/ai/types'
import {type Db} from '@/lib/db'

const ORDER = ['join', 'carried', 'math', 'numbers', 'merge', 'renumber', 'answers'] as const

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
    .select({id: questions.id, printedNumber: questions.printedNumber})
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

export interface ExtractProgress {
  page: number
  total: number
}

export interface ExtractOutcome {
  pagesProcessed: number
  questionsCreated: number
}

export async function runExtraction(
  db: Db,
  provider: AIProvider,
  job: {id: string; worksheetId: string; userId: string; checkpoint: Record<string, unknown> | null},
  onProgress?: (progress: ExtractProgress) => void,
): Promise<ExtractOutcome> {
  const pages = await db
    .select()
    .from(worksheetPages)
    .where(eq(worksheetPages.worksheetId, job.worksheetId))
    .orderBy(asc(worksheetPages.pageNumber))

  if (pages.length === 0) {
    throw new Error('Worksheet has no pages.')
  }

  const startAfter = Number(job.checkpoint?.lastPageNumber ?? 0)

  let created = 0
  let processed = 0

  for (const page of pages) {
    if (page.pageNumber <= startAfter) {
      processed += 1
      continue
    }

    if (isAnswerPage(page.ocrText ?? '')) {
      processed += 1
      await checkpointJob(db, job.id, processed / pages.length, {
        lastPageNumber: page.pageNumber,
      })
      onProgress?.({page: page.pageNumber, total: pages.length})
      console.log(
        `[extract] page ${page.pageNumber} is an answer key or solutions page; not extracted`,
      )
      continue
    }

    const object = await storage.get(page.imageKey)
    if (!object) {
      throw new Error(`Page image missing for page ${page.pageNumber}.`)
    }

    const extracted = await provider.extractQuestions({
      image: new Uint8Array(object.body),
      mediaType: object.contentType,
      text: page.ocrText ?? '',
      width: page.width ?? 0,
      height: page.height ?? 0,
      pageNumber: page.pageNumber,
      ...seamAround(pages, pages.indexOf(page)),
    })

    created += await persistQuestions(db, job, page.id, extracted)
    processed += 1

    await checkpointJob(db, job.id, processed / pages.length, {
      lastPageNumber: page.pageNumber,
    })

    onProgress?.({page: page.pageNumber, total: pages.length})
  }

  return {pagesProcessed: processed, questionsCreated: created}
}

function mergeSplitQuestions(extracted: ExtractedQuestion[]): ExtractedQuestion[] {
  const byPrompt = new Map<string, ExtractedQuestion>()

  for (const question of extracted) {
    const key =
      question.ordinal >= 1
        ? `#${question.ordinal}`
        : normalizeForCompare(question.prompt_text)

    const seen = byPrompt.get(key)

    if (!seen) {
      byPrompt.set(key, {...question, choices: [...question.choices]})
      continue
    }

    if (isOptionRun(seen.prompt_text) && !isOptionRun(question.prompt_text)) {
      seen.prompt_text = question.prompt_text
      seen.question_type = question.question_type
      seen.bbox = question.bbox
    }

    for (const choice of question.choices) {
      const duplicate = seen.choices.some(
        (existing) =>
          normalizeForCompare(existing.label) === normalizeForCompare(choice.label) ||
          normalizeOptionText(existing.text) === normalizeOptionText(choice.text),
      )
      if (!duplicate) seen.choices.push(choice)
    }
  }

  return [...byPrompt.values()]
}

export async function persistQuestions(
  db: Db,
  job: {worksheetId: string; userId: string},
  pageId: string,
  raw: ExtractedQuestion[],
): Promise<number> {
  if (raw.length === 0) return 0

  const [page] = await db
    .select({ocrText: worksheetPages.ocrText, pageNumber: worksheetPages.pageNumber})
    .from(worksheetPages)
    .where(eq(worksheetPages.id, pageId))
    .limit(1)

  if (page && isAnswerPage(page.ocrText ?? '')) {
    console.log(
      `[ingest] dropped ${raw.length} row(s) read off an answer key or ` +
        `solutions page on ${job.worksheetId}`,
    )
    return 0
  }

  const labelled = raw.map((question) => ({
    ...question,
    choices: question.choices.map((choice) => ({
      ...choice,
      label: normalizeChoiceLabel(choice.label),
    })),
  }))

  const merged = mergeSplitQuestions(labelled).map(foldLeadInChoices)

  const extracted = merged.filter((question) => {
    if (!isOptionRun(question.prompt_text)) return true
    console.log(
      `[ingest] dropped an option block stored as question ` +
        `${question.ordinal >= 1 ? question.ordinal : '?'} on ${job.worksheetId}`,
    )
    return false
  })

  if (extracted.length === 0) return 0

  const printed = printedNumbersFor(
    page?.ocrText ?? '',
    extracted.map((question) => question.prompt_text),
  )

  const existing = await db
    .select({ordinal: questions.ordinal, contentHash: questions.contentHash})
    .from(questions)
    .where(eq(questions.worksheetId, job.worksheetId))

  let nextOrdinal = existing.reduce((max, row) => Math.max(max, row.ordinal), 0) + 1

  const seen = new Set(
    existing.map((row) => row.contentHash).filter((hash): hash is string => !!hash),
  )

  let duplicatesDropped = 0

  const pending: {
    row: typeof questions.$inferInsert
    choices: {label: string; text: string}[]
  }[] = []

  for (const [index, raw] of extracted.entries()) {
    const question = {
      ...raw,
      prompt_text: reflowText(normalizeMath(raw.prompt_text)),
      choices: raw.choices.map((choice) => ({
        ...choice,
        text: reflowText(normalizeMath(choice.text)),
      })),
    }

    const contentHash = hashQuestion(question.prompt_text, question.choices)

    if (seen.has(contentHash)) {
      duplicatesDropped += 1
      continue
    }
    seen.add(contentHash)

    pending.push({
      row: {
        userId: job.userId,
        worksheetId: job.worksheetId,
        pageId,
        ordinal: nextOrdinal,
        printedNumber: printed[index] ?? (question.ordinal >= 1 ? question.ordinal : null),
        promptText: question.prompt_text,
        questionType: question.question_type,
        bbox: question.bbox,

        userVerified: false,
        answerSource: 'none' as const,
        contentHash,
      },
      choices: question.choices,
    })

    nextOrdinal += 1
  }

  if (duplicatesDropped > 0) {
    console.log(
      `[ingest] page ${page?.pageNumber ?? '?'}: dropped ${duplicatesDropped} question(s) ` +
        `already read word for word, kept ${pending.length}`,
    )
  }

  if (pending.length === 0) return 0

  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(questions)
      .values(pending.map((item) => item.row))
      .returning({id: questions.id})

    const choiceRows = pending.flatMap((item, index) =>
      item.choices.map((choice) => ({
        questionId: inserted[index].id,
        label: choice.label,
        text: choice.text,
        isCorrect: false,
      })),
    )

    if (choiceRows.length > 0) await tx.insert(answerChoices).values(choiceRows)
  })

  return pending.length
}

export async function pagesForJob(db: Db, worksheetId: string) {
  return db
    .select({
      id: worksheetPages.id,
      pageNumber: worksheetPages.pageNumber,
      imageKey: worksheetPages.imageKey,
      ocrText: worksheetPages.ocrText,
      width: worksheetPages.width,
      height: worksheetPages.height,
    })
    .from(worksheetPages)
    .where(eq(worksheetPages.worksheetId, worksheetId))
    .orderBy(asc(worksheetPages.pageNumber))
}
