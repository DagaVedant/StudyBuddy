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
  isOptionRun,
  modalChoiceCount,
  planPageSplitJoins,
  printedNumbersFor,
  type SplitHalf,
} from '@/lib/questions/numbering'
import {
  foldLeadInChoices,
  hashQuestion,
  isAnswerPage,
  mergeAnswerKeys,
  normalizeChoiceLabel,
  normalizeForCompare,
  normalizeMath,
  normalizeOptionText,
  parseAnswerKey,
  reflowText,
  seamAround,
} from '@/lib/questions/shape'
import {checkpointJob, storage} from '@/lib/queue'
import {loadQuestionsWithChoices} from '@/lib/questions/queries'
import {type AIProvider, type ExtractedQuestion} from '@/lib/ai/types'
import {type Db} from '@/lib/db'

const ORDER = ['join', 'carried', 'math', 'numbers', 'merge', 'renumber', 'answers'] as const

export type RepairPass = (typeof ORDER)[number]

export type RepairCounts = {
  joined: number
  recovered: number
  rendered: number
  repaired: number
  merged: number
  renumbered: number
  answered: number
  duplicateNumbers: number[]
}

export type RepairOptions = {
  only?: readonly RepairPass[]
  log?: string | null
}

export async function runRepairPasses(
  db: Db,
  worksheetId: string,
  options: RepairOptions = {},
): Promise<RepairCounts> {
  let wanted = new Set<RepairPass>()

  if (options.only) {
    for (let pass of options.only) wanted.add(pass)
  } else {
    for (let pass of ORDER) wanted.add(pass)
  }

  let log: string | null = ''
  if (options.log !== undefined) log = options.log

  const counts: RepairCounts = {
    joined: 0,
    recovered: 0,
    rendered: 0,
    repaired: 0,
    merged: 0,
    renumbered: 0,
    answered: 0,
    duplicateNumbers: [],
  }

  function note(message: string) {
    if (log !== null) console.log(log + message + ' on ' + worksheetId)
  }

  if (wanted.has('join')) {
    const result = await joinSplitQuestions(db, worksheetId)
    counts.joined = result.joined

    if (result.joined > 0) note('[split] rejoined ' + result.joined + ' question(s)')
  }

  if (wanted.has('carried')) {
    const result = await recoverCarriedChoices(db, worksheetId)
    counts.recovered = result.recovered

    if (result.recovered > 0) {
      note('[carried] recovered options for ' + result.recovered + ' question(s)')
    }
  }

  if (wanted.has('math')) {
    const result = await repairUnrenderedMath(db, worksheetId)
    counts.rendered = result.repaired

    if (result.repaired > 0) {
      note('[maths] re-rendered ' + result.repaired + ' question(s)')
    }
  }

  if (wanted.has('numbers')) {
    const result = await repairPrintedNumbers(db, worksheetId)
    counts.repaired = result.repaired

    if (result.repaired > 0) {
      note('[numbers] recovered ' + result.repaired + ' printed number(s)')
    }
  }

  if (wanted.has('merge')) {
    const result = await mergeDuplicateQuestions(db, worksheetId)
    counts.merged = result.merged

    if (result.merged > 0) {
      note('[dedupe] folded ' + result.merged + ' duplicate question(s)')
    }
  }

  if (wanted.has('renumber')) {
    const result = await renumberQuestions(db, worksheetId)
    counts.renumbered = result.renumbered
    counts.duplicateNumbers = result.duplicateNumbers

    if (result.renumbered > 0) {
      note('[renumber] reordered ' + result.renumbered + ' question(s)')
    }

    if (result.duplicateNumbers.length > 0) {
      note(
        '[renumber] printed number(s) claimed twice: ' +
          result.duplicateNumbers.join(', '),
      )
    }
  }

  if (wanted.has('answers')) {
    const result = await applyAnswerKey(db, worksheetId)
    counts.answered = result.answered

    if (result.answered > 0) {
      note('[key] answered ' + result.answered + ' question(s) from the paper')
    }
  }

  return counts
}

export const VERIFYING_PASSES = ['join', 'carried', 'math', 'merge'] as const

export const FINAL_PASSES = ORDER

async function applyAnswerKey(db: Db, worksheetId: string) {
  const pages = await db
    .select({ocrText: worksheetPages.ocrText})
    .from(worksheetPages)
    .where(eq(worksheetPages.worksheetId, worksheetId))
    .orderBy(asc(worksheetPages.pageNumber))

  let parsed = []
  for (let page of pages) {
    let text = ''
    if (page.ocrText) text = page.ocrText

    parsed.push(parseAnswerKey(text))
  }

  const key = mergeAnswerKeys(parsed)
  if (key.size === 0) return {answered: 0}

  const rows = await db
    .select({id: questions.id, printedNumber: questions.printedNumber})
    .from(questions)
    .where(
      and(eq(questions.worksheetId, worksheetId), ne(questions.answerSource, 'user_key')),
    )

  let answered = 0

  for (let row of rows) {
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

    for (let choice of choices) {
      const isCorrect = normalizeChoiceLabel(choice.label).toUpperCase() === label

      if (choice.isCorrect === isCorrect) continue

      await db
        .update(answerChoices)
        .set({isCorrect})
        .where(eq(answerChoices.id, choice.id))
    }

    answered = answered + 1
  }

  return {answered}
}

async function repairUnrenderedMath(db: Db, worksheetId: string) {
  const rows = await loadQuestionsWithChoices(db, worksheetId)

  if (rows.length === 0) return {repaired: 0}

  let repaired = 0

  for (let row of rows) {
    const promptText = normalizeMath(row.promptText)

    let fixed = []
    let changed = []

    for (let choice of row.choices) {
      const text = normalizeMath(choice.text)

      fixed.push({id: choice.id, text: text})
      if (text !== choice.text) changed.push({id: choice.id, text: text})
    }

    if (promptText === row.promptText && changed.length === 0) continue

    for (let choice of changed) {
      await db
        .update(answerChoices)
        .set({text: choice.text})
        .where(eq(answerChoices.id, choice.id))
    }

    const contentHash = hashQuestion(promptText, fixed)

    await db
      .update(questions)
      .set({promptText, contentHash})
      .where(eq(questions.id, row.id))

    repaired = repaired + 1

    console.log(
      '[maths] rewrote ' + row.id + ' on ' + worksheetId + ': ' + promptText.slice(0, 60),
    )
  }

  return {repaired}
}

async function repairPrintedNumbers(db: Db, worksheetId: string) {
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

  let placed = []
  for (let row of rows) {
    placed.push({
      id: row.id,
      pageNumber: row.pageNumber,
      position: row.ordinal,
      printedNumber: row.printedNumber,
    })
  }

  let expected = null
  if (sheet && sheet.expected !== null) expected = sheet.expected

  const fixes = inferPrintedNumbers(placed, expected)

  for (let fix of fixes) {
    await db.update(questions).set({printedNumber: fix.to}).where(eq(questions.id, fix.id))

    let from = 'blank'
    if (fix.from !== null) from = String(fix.from)

    console.log(
      '[numbers] ' + fix.reason + ' on ' + worksheetId + ': ' + from + ' -> ' + fix.to,
    )
  }

  return {repaired: fixes.length}
}

async function renumberQuestions(db: Db, worksheetId: string) {
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

  let ordered = rows.slice()

  ordered.sort(function (a, b) {
    let pageA = a.pageNumber
    if (pageA === null) pageA = Number.MAX_SAFE_INTEGER

    let pageB = b.pageNumber
    if (pageB === null) pageB = Number.MAX_SAFE_INTEGER

    if (pageA !== pageB) return pageA - pageB

    let printedA = a.printedNumber
    if (printedA === null) printedA = Number.MAX_SAFE_INTEGER

    let printedB = b.printedNumber
    if (printedB === null) printedB = Number.MAX_SAFE_INTEGER

    if (printedA !== printedB) return printedA - printedB

    return a.ordinal - b.ordinal
  })

  let moved = []

  for (let index = 0; index < ordered.length; index++) {
    let ordinal = index + 1
    if (ordered[index].ordinal === ordinal) continue

    moved.push({id: ordered[index].id, ordinal: ordinal})
  }

  if (moved.length > 0) {
    let pairs = []
    for (let row of moved) pairs.push(sql`(${row.id}, ${row.ordinal}::int)`)

    const values = sql.join(pairs, sql`, `)

    await db.execute(sql`
      update ${questions} as q
      set ordinal = v.ordinal
      from (values ${values}) as v(id, ordinal)
      where q.id = v.id
    `)
  }

  return {renumbered: moved.length, duplicateNumbers}
}

async function joinSplitQuestions(db: Db, worksheetId: string) {
  const rows = await loadQuestionsWithChoices(db, worksheetId)

  if (rows.length < 2) return {joined: 0}

  let candidates: SplitHalf[] = []

  for (let row of rows) {
    candidates.push({
      id: row.id,
      pageNumber: row.pageNumber,
      position: row.ordinal,
      top: row.top,
      printedNumber: row.printedNumber,
      promptText: row.promptText,
      questionType: row.questionType,
      choices: row.choices,
    })
  }

  const plans = planPageSplitJoins(candidates, {
    expectedChoiceCount: modalChoiceCount(candidates),
  })

  let byId = new Map<string, SplitHalf>()
  for (let candidate of candidates) byId.set(candidate.id, candidate)

  let dropIds = []
  for (let plan of plans) dropIds.push(plan.dropId)

  const deletable = new Set(await deletableQuestionIds(db, dropIds))

  let joined = 0

  for (let plan of plans) {
    const keep = byId.get(plan.keepId)
    const drop = byId.get(plan.dropId)
    if (!keep || !drop) continue

    if (!deletable.has(plan.dropId)) {
      console.log(
        '[split] left ' + plan.dropId + ' on ' + worksheetId + ': a student has work against it',
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
    joined = joined + 1

    console.log('[split] ' + plan.reason + ' on ' + worksheetId)
  }

  return {joined}
}

export type ExtractProgress = {
  page: number
  total: number
}

export type ExtractOutcome = {
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

  let startAfter = 0
  if (job.checkpoint && job.checkpoint.lastPageNumber) {
    startAfter = Number(job.checkpoint.lastPageNumber)
  }

  let created = 0
  let processed = 0

  for (let index = 0; index < pages.length; index++) {
    const page = pages[index]

    if (page.pageNumber <= startAfter) {
      processed = processed + 1
      continue
    }

    let ocrText = ''
    if (page.ocrText) ocrText = page.ocrText

    if (isAnswerPage(ocrText)) {
      processed = processed + 1

      await checkpointJob(db, job.id, processed / pages.length, {
        lastPageNumber: page.pageNumber,
      })

      if (onProgress) onProgress({page: page.pageNumber, total: pages.length})

      console.log(
        '[extract] page ' +
          page.pageNumber +
          ' is an answer key or solutions page; not extracted',
      )
      continue
    }

    const object = await storage.get(page.imageKey)
    if (!object) {
      throw new Error('Page image missing for page ' + page.pageNumber + '.')
    }

    const seam = seamAround(pages, index)

    let width = 0
    if (page.width) width = page.width

    let height = 0
    if (page.height) height = page.height

    const extracted = await provider.extractQuestions({
      image: new Uint8Array(object.body),
      mediaType: object.contentType,
      text: ocrText,
      width: width,
      height: height,
      pageNumber: page.pageNumber,
      before: seam.before,
      after: seam.after,
    })

    created = created + (await persistQuestions(db, job, page.id, extracted))
    processed = processed + 1

    await checkpointJob(db, job.id, processed / pages.length, {
      lastPageNumber: page.pageNumber,
    })

    if (onProgress) onProgress({page: page.pageNumber, total: pages.length})
  }

  return {pagesProcessed: processed, questionsCreated: created}
}

function mergeSplitQuestions(extracted: ExtractedQuestion[]) {
  let byPrompt = new Map<string, ExtractedQuestion>()

  for (let question of extracted) {
    let key = normalizeForCompare(question.prompt_text)
    if (question.ordinal >= 1) key = '#' + question.ordinal

    const seen = byPrompt.get(key)

    if (!seen) {
      byPrompt.set(key, {...question, choices: question.choices.slice()})
      continue
    }

    if (isOptionRun(seen.prompt_text) && !isOptionRun(question.prompt_text)) {
      seen.prompt_text = question.prompt_text
      seen.question_type = question.question_type
      seen.bbox = question.bbox
    }

    for (let choice of question.choices) {
      let duplicate = false

      for (let existing of seen.choices) {
        if (normalizeForCompare(existing.label) === normalizeForCompare(choice.label)) {
          duplicate = true
        }

        if (normalizeOptionText(existing.text) === normalizeOptionText(choice.text)) {
          duplicate = true
        }
      }

      if (!duplicate) seen.choices.push(choice)
    }
  }

  let out: ExtractedQuestion[] = []
  for (let question of byPrompt.values()) out.push(question)

  return out
}

export async function persistQuestions(
  db: Db,
  job: {worksheetId: string; userId: string},
  pageId: string,
  raw: ExtractedQuestion[],
) {
  if (raw.length === 0) return 0

  const [page] = await db
    .select({ocrText: worksheetPages.ocrText, pageNumber: worksheetPages.pageNumber})
    .from(worksheetPages)
    .where(eq(worksheetPages.id, pageId))
    .limit(1)

  let pageText = ''
  if (page && page.ocrText) pageText = page.ocrText

  if (page && isAnswerPage(pageText)) {
    console.log(
      '[ingest] dropped ' +
        raw.length +
        ' row(s) read off an answer key or solutions page on ' +
        job.worksheetId,
    )
    return 0
  }

  let labelled: ExtractedQuestion[] = []

  for (let question of raw) {
    let choices = []

    for (let choice of question.choices) {
      choices.push({...choice, label: normalizeChoiceLabel(choice.label)})
    }

    labelled.push({...question, choices: choices})
  }

  let merged = []
  for (let question of mergeSplitQuestions(labelled)) merged.push(foldLeadInChoices(question))

  let extracted: ExtractedQuestion[] = []

  for (let question of merged) {
    if (!isOptionRun(question.prompt_text)) {
      extracted.push(question)
      continue
    }

    let number = '?'
    if (question.ordinal >= 1) number = String(question.ordinal)

    console.log(
      '[ingest] dropped an option block stored as question ' +
        number +
        ' on ' +
        job.worksheetId,
    )
  }

  if (extracted.length === 0) return 0

  let prompts = []
  for (let question of extracted) prompts.push(question.prompt_text)

  const printed = printedNumbersFor(pageText, prompts)

  const existing = await db
    .select({ordinal: questions.ordinal, contentHash: questions.contentHash})
    .from(questions)
    .where(eq(questions.worksheetId, job.worksheetId))

  let nextOrdinal = 1
  let seen = new Set<string>()

  for (let row of existing) {
    if (row.ordinal >= nextOrdinal) nextOrdinal = row.ordinal + 1
    if (row.contentHash) seen.add(row.contentHash)
  }

  let duplicatesDropped = 0

  let pending: {
    row: typeof questions.$inferInsert
    choices: {label: string; text: string}[]
  }[] = []

  for (let index = 0; index < extracted.length; index++) {
    const entry = extracted[index]

    const promptText = reflowText(normalizeMath(entry.prompt_text))

    let choices = []
    for (let choice of entry.choices) {
      choices.push({label: choice.label, text: reflowText(normalizeMath(choice.text))})
    }

    const contentHash = hashQuestion(promptText, choices)

    if (seen.has(contentHash)) {
      duplicatesDropped = duplicatesDropped + 1
      continue
    }

    seen.add(contentHash)

    let printedNumber = printed[index]

    if (printedNumber === undefined || printedNumber === null) {
      printedNumber = null
      if (entry.ordinal >= 1) printedNumber = entry.ordinal
    }

    pending.push({
      row: {
        userId: job.userId,
        worksheetId: job.worksheetId,
        pageId,
        ordinal: nextOrdinal,
        printedNumber: printedNumber,
        promptText: promptText,
        questionType: entry.question_type,
        bbox: entry.bbox,

        userVerified: false,
        answerSource: 'none',
        contentHash,
      },
      choices: choices,
    })

    nextOrdinal = nextOrdinal + 1
  }

  if (duplicatesDropped > 0) {
    let pageLabel = '?'
    if (page) pageLabel = String(page.pageNumber)

    console.log(
      '[ingest] page ' +
        pageLabel +
        ': dropped ' +
        duplicatesDropped +
        ' question(s) already read word for word, kept ' +
        pending.length,
    )
  }

  if (pending.length === 0) return 0

  await db.transaction(async (tx) => {
    let rows = []
    for (let item of pending) rows.push(item.row)

    const inserted = await tx.insert(questions).values(rows).returning({id: questions.id})

    let choiceRows = []

    for (let index = 0; index < pending.length; index++) {
      for (let choice of pending[index].choices) {
        choiceRows.push({
          questionId: inserted[index].id,
          label: choice.label,
          text: choice.text,
          isCorrect: false,
        })
      }
    }

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
