import { asc, eq } from 'drizzle-orm'

import type { AIProvider, ExtractedQuestion } from '@/lib/ai/types'
import type { Db } from '@/lib/db/types'
import {
  answerChoices,
  questions,
  worksheetPages,
  worksheets,
} from '@/lib/db/schema'
import { foldLeadInChoices } from '@/lib/questions/lead-in'
import { normalizeMath } from '@/lib/questions/math'
import { reflowText } from '@/lib/questions/reflow'
import {
  hashQuestion,
  normalizeChoiceLabel,
  normalizeForCompare,
} from '@/lib/questions/shape'
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
    })

    created += await persistQuestions(db, job, page.id, extracted)
    processed += 1

    await checkpointJob(db, job.id, processed / pages.length, {
      lastPageNumber: page.pageNumber,
    })

    onProgress?.({ page: page.pageNumber, total: pages.length })
  }

  await db
    .update(worksheets)
    .set({ status: 'awaiting_review' })
    .where(eq(worksheets.id, job.worksheetId))

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

    for (const choice of question.choices) {
      const duplicate = seen.choices.some(
        (existing) =>
          normalizeForCompare(existing.label) === normalizeForCompare(choice.label) ||
          normalizeForCompare(existing.text) === normalizeForCompare(choice.text),
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
  // Labels first, before anything reads one. Four of the five providers parse
  // their own output through the extraction schema, which normalises the label
  // on the way; a provider that does not (the mock does not) hands its rows
  // straight to the insert below. The result was options stored as `A. 60`
  // instead of `A`, and a malformed label does not merely look wrong: it is a
  // single letter that every downstream test demands. `foldLeadInChoices` and
  // `labelStyle` both match /^[a-z]$/, so a stuck-together label silently
  // switches off the lead-in fold and the duplicate merge, and the answer key
  // cannot find the option the paper marked. One normalisation here covers
  // every provider and both routes into this function.
  const labelled = raw.map((question) => ({
    ...question,
    choices: question.choices.map((choice) => ({
      ...choice,
      label: normalizeChoiceLabel(choice.label),
    })),
  }))

  // After the merge, not before: the union of two split rows is one of the two
  // ways a question ends up holding both its options and the sentences they
  // were built from, and it only exists once the merge has run.
  const extracted = mergeSplitQuestions(labelled).map(foldLeadInChoices)
  if (extracted.length === 0) return 0

  const existing = await db
    .select({ ordinal: questions.ordinal, contentHash: questions.contentHash })
    .from(questions)
    .where(eq(questions.worksheetId, job.worksheetId))

  let nextOrdinal = existing.reduce((max, row) => Math.max(max, row.ordinal), 0) + 1

  const seen = new Set(
    existing.map((row) => row.contentHash).filter((hash): hash is string => !!hash),
  )

  let created = 0

  for (const raw of extracted) {
    // Normalised before hashing and before storing, so the hash matches what
    // the student actually reads and the same question written two ways does
    // not survive as two rows.
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

    if (seen.has(contentHash)) continue
    seen.add(contentHash)

    const [row] = await db
      .insert(questions)
      .values({
        userId: job.userId,
        worksheetId: job.worksheetId,
        pageId,
        ordinal: nextOrdinal,
        printedNumber: question.ordinal >= 1 ? question.ordinal : null,
        promptText: question.prompt_text,
        questionType: question.question_type,
        bbox: question.bbox,

        userVerified: false,
        answerSource: 'none',
        contentHash,
      })
      .returning({ id: questions.id })

    if (question.choices.length > 0) {
      await db.insert(answerChoices).values(
        question.choices.map((choice) => ({
          questionId: row.id,
          label: choice.label,
          text: choice.text,
          isCorrect: false,
        })),
      )
    }

    nextOrdinal += 1
    created += 1
  }

  return created
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

