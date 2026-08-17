import { asc, eq } from 'drizzle-orm'

import type { AIProvider, ExtractedQuestion } from '@/lib/ai/types'
import type { Db } from '@/lib/db/types'
import { answerChoices, questions, worksheetPages } from '@/lib/db/schema'
import { isAnswerPage } from '@/lib/questions/answer-key'
import { foldLeadInChoices } from '@/lib/questions/lead-in'
import { normalizeMath } from '@/lib/questions/math'
import { seamAround } from '@/lib/questions/page-text'
import { printedNumbersFor } from '@/lib/questions/numbering'
import { reflowText } from '@/lib/questions/reflow'
import {
  hashQuestion,
  normalizeChoiceLabel,
  normalizeForCompare,
  normalizeOptionText,
} from '@/lib/questions/shape'
import { isOptionRun } from '@/lib/questions/validate'
import { checkpointJob } from '@/lib/queue'
import { storage } from '@/lib/storage'

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
  job: { id: string; worksheetId: string; userId: string; checkpoint: Record<string, unknown> | null },
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
      onProgress?.({ page: page.pageNumber, total: pages.length })
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

    onProgress?.({ page: page.pageNumber, total: pages.length })
  }

  return { pagesProcessed: processed, questionsCreated: created }
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
      byPrompt.set(key, { ...question, choices: [...question.choices] })
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
  job: { worksheetId: string; userId: string },
  pageId: string,
  raw: ExtractedQuestion[],
): Promise<number> {
  if (raw.length === 0) return 0

  const [page] = await db
    .select({ ocrText: worksheetPages.ocrText, pageNumber: worksheetPages.pageNumber })
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
    .select({ ordinal: questions.ordinal, contentHash: questions.contentHash })
    .from(questions)
    .where(eq(questions.worksheetId, job.worksheetId))

  let nextOrdinal = existing.reduce((max, row) => Math.max(max, row.ordinal), 0) + 1

  const seen = new Set(
    existing.map((row) => row.contentHash).filter((hash): hash is string => !!hash),
  )

  let duplicatesDropped = 0

  const pending: {
    row: typeof questions.$inferInsert
    choices: { label: string; text: string }[]
  }[] = []

  for (const [index, raw] of extracted.entries()) {
    const question = {
      ...raw,
      // Reflowed after the maths, never before: the recovery of an eaten
      // command reads a line break followed by letters, and joining the lines
      // first would leave it nothing to find.
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
      .returning({ id: questions.id })

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

