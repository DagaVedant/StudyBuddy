import { createHash } from 'node:crypto'

import { asc, eq, inArray } from 'drizzle-orm'

import type { AIProvider, ExtractedQuestion } from '@/lib/ai/types'
import type { Db } from '@/lib/dashboard/queries'
import {
  answerChoices,
  questions,
  worksheetPages,
  worksheets,
} from '@/lib/db/schema'
import { contentHashSource, normalizeForCompare } from '@/lib/questions/shape'
import { checkpointJob } from '@/lib/queue'
import { storage } from '@/lib/storage'

/**
 * Runs the extraction stage for one worksheet.
 *
 * Shared by the Tier B server worker and the Tier 0 operator GPU worker — the
 * only difference is which provider is passed in and where the process runs
 * (spec §3.5: the pipeline is shared, only the executor differs).
 */

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

  // Resume from where a previous attempt died rather than re-running pages
  // that already produced questions.
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

  // Extraction is done, but nothing counts until the student confirms it
  // (spec §4 stage 5) — hence awaiting_review, not ready.
  await db
    .update(worksheets)
    .set({ status: 'awaiting_review' })
    .where(eq(worksheets.id, job.worksheetId))

  return { pagesProcessed: processed, questionsCreated: created }
}

/**
 * Writes one page's extracted questions.
 *
 * Shared by both executors — the Tier 0 GPU worker posts results to the worker
 * API, the Tier B path calls it directly — so dedup and ordinal continuity
 * behave the same either way. They diverged once and only one side got fixed.
 */
/**
 * Folds a page's repeated questions back into one entry each.
 *
 * A vision model splits a multiple-choice question when every option is itself
 * a block of text — a page of long quotations came back as the same stem four
 * times, each carrying one option. Hash dedup cannot see that, because
 * prompt+choices genuinely differ.
 *
 * Telling the model not to does nothing. Instructing it that each question
 * appears exactly once, that a multi-line option is still an option, and that
 * repeating a stem means it should extend the previous entry produced output
 * byte-identical to the unmodified prompt across three pages.
 *
 * It does not need telling, though: it already labels every copy with the
 * question's printed number. That page came back as ordinals
 * [27, 28, 29, 29, 29, 29] — it knew the last four were one question. So the
 * printed number is the key, and the text is only a fallback for genuinely
 * unnumbered questions, where 0 means "no number on the page".
 */
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
  const extracted = mergeSplitQuestions(raw)
  if (extracted.length === 0) return 0

  // Ordinals continue across pages rather than restarting at 1 per page.
  const existing = await db
    .select({ ordinal: questions.ordinal, contentHash: questions.contentHash })
    .from(questions)
    .where(eq(questions.worksheetId, job.worksheetId))

  let nextOrdinal = existing.reduce((max, row) => Math.max(max, row.ordinal), 0) + 1

  /*
   * A local model can stutter, repeating the same question several times in one
   * reply — a real reading page emitted the same question four times. Two
   * questions with identical wording *and* identical options are not two
   * questions on a practice test, so the hash the schema already keeps for
   * dedup is applied at insert instead of after the fact.
   */
  const seen = new Set(
    existing.map((row) => row.contentHash).filter((hash): hash is string => !!hash),
  )

  let created = 0

  for (const question of extracted) {
    const contentHash = createHash('sha256')
      .update(contentHashSource(question.prompt_text, question.choices))
      .digest('hex')

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
        // Nothing the model produced is trusted until the student confirms it.
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

/** Page images the worker needs, resolved for a claimed job. */
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

/** True when this storage key belongs to a worksheet with a live claim. */
export async function keyBelongsToActiveJob(
  db: Db,
  key: string,
  worksheetIds: string[],
): Promise<boolean> {
  if (worksheetIds.length === 0) return false

  const rows = await db
    .select({ imageKey: worksheetPages.imageKey })
    .from(worksheetPages)
    .where(inArray(worksheetPages.worksheetId, worksheetIds))

  return rows.some((row) => row.imageKey === key)
}
