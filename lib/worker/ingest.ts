import { asc, eq } from 'drizzle-orm'

import type { AIProvider, ExtractedQuestion } from '@/lib/ai/types'
import type { Db } from '@/lib/db/types'
import {
  answerChoices,
  questions,
  worksheetPages,
  worksheets,
} from '@/lib/db/schema'
import { isAnswerPage } from '@/lib/questions/answer-key'
import { foldLeadInChoices } from '@/lib/questions/lead-in'
import { normalizeMath } from '@/lib/questions/math'
import { printedNumbersFor } from '@/lib/questions/printed-numbers'
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

    // The paper's answer key and worked solutions are not questions, and the
    // model reads them as questions anyway. Decided before the call rather
    // than after, so a key page costs nothing to skip. persistQuestions makes
    // the same decision again for the paths that do not come through here.
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

    // The first half seen keeps the prompt, which is right when it is a stem
    // and wrong when it is the option block that was printed above the stem.
    // Two rows numbered 17, one of them "A. 1 hole B. 4 holes C. 2 holes same
    // side D. 2 holes opposite sides" and the other the actual question, must
    // not come out of here with the option run as the surviving stem: the
    // filter in persistQuestions drops an option-run prompt, and it would take
    // the real question's options with it.
    if (isOptionRun(seen.prompt_text) && !isOptionRun(question.prompt_text)) {
      seen.prompt_text = question.prompt_text
      seen.question_type = question.question_type
      seen.bbox = question.bbox
    }

    for (const choice of question.choices) {
      // The option's own comparison for its text. On the prose one "-2" and
      // "2" are the same string, so joining two halves of a question dropped
      // whichever sign arrived second, and the student was left choosing
      // between three options where the paper printed four.
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

  // Nothing a page of answers produces is a question, whichever route it came
  // in by. The GPU worker posts its pages to the job route rather than going
  // through runExtraction, and it is a separately deployed process that can be
  // running last month's code, so the decision is made again here where every
  // writer has to pass: a worker that skips the page saves a model call, and
  // one that does not still cannot store what it read.
  //
  // This is the failure that hid the worst one. The sixteen rows those pages
  // produced carried the printed numbers of the questions they were answers
  // to, so the coverage audit counted them as covered and never re-read the
  // two pages test8_15 had actually lost.
  const [page] = await db
    .select({ ocrText: worksheetPages.ocrText })
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
  const merged = mergeSplitQuestions(labelled).map(foldLeadInChoices)

  // A row whose whole prompt is a run of options is an orphaned option block,
  // never a question. `topic_test13_20` stores one as its question 17, so the
  // sheet holds twenty rows for a twenty-question paper with no gap in the
  // numbering and every count-based check passes, while the real stem for 17
  // is gone. Dropping it turns a silent corruption into a visible gap, which
  // the audit re-reads, and leaves the options on the page for the carried
  // options recovery to hand to the question they belong to.
  //
  // After the merge, because a block that arrived as its own row alongside the
  // stem it belongs to is joined here rather than dropped.
  const extracted = merged.filter((question) => {
    if (!isOptionRun(question.prompt_text)) return true
    console.log(
      `[ingest] dropped an option block stored as question ` +
        `${question.ordinal >= 1 ? question.ordinal : '?'} on ${job.worksheetId}`,
    )
    return false
  })

  if (extracted.length === 0) return 0

  // What the page prints, which outranks what the model counted. Read once for
  // the whole batch: a page re-read on its own comes back numbered from 1, and
  // taking those numbers at face value files a page of recovered questions on
  // top of another page's real ones.
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

  let created = 0

  for (const [index, raw] of extracted.entries()) {
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
        // The page's own number when it could be found, and the model's count
        // only when it could not.
        printedNumber: printed[index] ?? (question.ordinal >= 1 ? question.ordinal : null),
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

