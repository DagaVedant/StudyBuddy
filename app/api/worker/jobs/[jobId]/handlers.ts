import { and, eq, inArray } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import type { z } from 'zod'

import type { Db } from '@/lib/db/types'
import {
  answerChoices,
  explanations,
  processingJobs,
  questionSolutions,
  questions,
  worksheetPages,
} from '@/lib/db/schema'
import { checkpointJob, completeJob, enqueueJob, failJob } from '@/lib/queue'
import { CHOICE_ORDER } from '@/lib/questions/choice-order'
import { notifyWorksheet } from '@/lib/notifications/worksheet'
import { transitionWorksheet } from '@/lib/upload/claim'
import { applyPermanentFailure } from '@/lib/worker/fail'
import { persistQuestions } from '@/lib/worker/ingest'
import { promoteDerivedAnswer } from '@/lib/worker/solutions'
import { FINAL_PASSES, VERIFYING_PASSES, runRepairPasses } from '@/lib/worker/pipeline'
import { planPageReplacement } from '@/lib/worker/review'
import { partitionByDeletability } from '@/lib/worker/safe-delete'
import { CLASSIFYING_AT, VERIFYING_AT, readingProgress } from '@/lib/worker/progress'

import type { bodySchema } from './schema'

/**
 * One handler per action, moved out of the route so `route.ts` is the
 * dispatch table rather than the seven branches themselves.
 *
 * Each function still owns everything about its own action end to end: what
 * it reads, what it writes, and why. Splitting the *file* is what this is
 * for, not splitting the *reasoning* — a discriminated union where every
 * branch is independently readable was already the shape M-3 named as fine;
 * only the length of the one file holding all seven was the complaint.
 */

export type Job = typeof processingJobs.$inferSelect
type Body = z.infer<typeof bodySchema>
type Action<Name extends Body['action']> = Extract<Body, { action: Name }>

export async function handleFail(
  db: Db,
  jobId: string,
  job: Job,
  body: Action<'fail'>,
): Promise<NextResponse> {
  const { permanent } = await failJob(db, jobId, body.message)

  if (permanent) {
    await applyPermanentFailure(db, job)
  }

  return NextResponse.json({ ok: true, permanent })
}

export async function handlePhase(
  db: Db,
  jobId: string,
  job: Job,
  body: Action<'phase'>,
): Promise<NextResponse> {
  // Repaired before the audit reads the numbering, so it audits a repaired
  // run rather than chasing a gap a phantom row created.
  //
  // Both phases run the same passes in the same order (see
  // lib/worker/pipeline.ts) and the set only widens. Verifying holds the
  // numbering back because the audit and the review pass are still writing
  // rows after it. Classifying is the run that matters: a split only becomes
  // visible once both halves are stored, and on the AMC8 paper neither half
  // existed at the end of verifying: the stem and the orphaned options were
  // both recovered by the audit re-read, which runs after it. Repeating the
  // passes is safe; the second run finds nothing left to do.
  await runRepairPasses(db, job.worksheetId, {
    only: body.phase === 'classifying' ? FINAL_PASSES : VERIFYING_PASSES,
  })

  await checkpointJob(
    db,
    jobId,
    body.phase === 'classifying' ? CLASSIFYING_AT : VERIFYING_AT,
    // Carried through untouched: a phase change moves the bar, it does not
    // change where a resumed job would pick up from.
    job.checkpoint ?? {},
  )

  return NextResponse.json({ ok: true })
}

export async function handlePageReview(
  db: Db,
  job: Job,
  body: Action<'page_review'>,
): Promise<NextResponse> {
  const [target] = await db
    .select({
      id: worksheetPages.id,
      worksheetId: worksheetPages.worksheetId,
      ocrText: worksheetPages.ocrText,
    })
    .from(worksheetPages)
    .where(eq(worksheetPages.id, body.pageId))
    .limit(1)

  if (!target || target.worksheetId !== job.worksheetId) {
    return NextResponse.json({ error: 'Page does not belong to this job' }, { status: 400 })
  }

  const doubted = body.replace.length
    ? await db
        .select({ id: questions.id, printedNumber: questions.printedNumber })
        .from(questions)
        .where(
          and(eq(questions.worksheetId, job.worksheetId), inArray(questions.id, body.replace)),
        )
    : []

  // The same guard the repair passes run behind (FIXES.md B-2), which this
  // path never had. Replacing a doubted row means deleting it, and
  // `questions` cascades to `attempts` and `review_cards`, so on a worksheet
  // the student had already marked up the audit re-read could take their
  // answer and its place in the revision schedule with it. Nothing would show
  // afterwards: the job reports the row as replaced either way.
  //
  // Applied before the plan is built rather than to its output, because
  // `planPageReplacement` pairs each doubted row with its replacement by
  // printed number. Dropping a row from the plan's input drops its
  // replacement with it; filtering afterwards would leave the replacement
  // behind and store it beside the original.
  const { removable: suspects, held } = await partitionByDeletability(db, doubted)

  if (held.length > 0) {
    console.log(
      `[review] kept ${held.length} doubted question(s) on ${job.worksheetId}: ` +
        'somebody has already answered them, and damaged beats absent',
    )
  }

  const plan = planPageReplacement(target.ocrText ?? '', body.questions, suspects)

  if (plan.replace.length > 0) {
    await db.delete(questions).where(
      inArray(
        questions.id,
        plan.replace.map((row) => row.id),
      ),
    )
  }

  const restored = await persistQuestions(db, job, target.id, plan.replacements)

  return NextResponse.json({
    ok: true,
    replaced: plan.replace.length,
    held: held.length,
    kept: plan.keep.length,
    restored,
  })
}

export async function handleExplanation(
  db: Db,
  job: Job,
  body: Action<'explanation'>,
): Promise<NextResponse> {
  const [question] = await db
    .select({ id: questions.id })
    .from(questions)
    .where(and(eq(questions.id, body.questionId), eq(questions.userId, job.userId)))
    .limit(1)

  if (!question) {
    return NextResponse.json({ error: 'Question does not belong to this job' }, { status: 400 })
  }

  await db.insert(explanations).values({
    questionId: body.questionId,
    attemptId: body.attemptId ?? null,
    bodyMd: body.bodyMd,
    misconceptionNote: body.misconceptionNote ?? null,
    // Left null: the column names a cloud vendor, and this came off the
    // operator's own GPU, which is not one of them.
    provider: null,
    model: body.model,
  })

  return NextResponse.json({ ok: true })
}

export async function handleSolution(
  db: Db,
  job: Job,
  body: Action<'solution'>,
): Promise<NextResponse> {
  const [question] = await db
    .select({
      id: questions.id,
      answerSource: questions.answerSource,
      worksheetId: questions.worksheetId,
    })
    .from(questions)
    .where(and(eq(questions.id, body.questionId), eq(questions.userId, job.userId)))
    .limit(1)

  if (!question || question.worksheetId !== job.worksheetId) {
    return NextResponse.json({ error: 'Question does not belong to this job' }, { status: 400 })
  }

  const choices = await db
    .select({ label: answerChoices.label, text: answerChoices.text })
    .from(answerChoices)
    .where(eq(answerChoices.questionId, body.questionId))
    .orderBy(...CHOICE_ORDER)

  await db
    .insert(questionSolutions)
    .values({
      questionId: body.questionId,
      derivedAnswer: body.answer,
      workingMd: body.workingMd,
      traps: body.traps,
      confidence: body.confidence,
      // Left null for the same reason as an explanation's: the column names a
      // cloud vendor and this came off the operator's own GPU.
      provider: null,
      model: body.model,
    })
    .onConflictDoNothing({ target: questionSolutions.questionId })

  const promoted = await promoteDerivedAnswer(db, {
    questionId: body.questionId,
    answer: body.answer,
    confidence: body.confidence,
    choices,
    answerSource: question.answerSource,
  })

  return NextResponse.json({ ok: true, promoted })
}

export async function handleComplete(
  db: Db,
  jobId: string,
  job: Job,
): Promise<NextResponse> {
  await completeJob(db, jobId)
  const delivered = await transitionWorksheet(
    db,
    job.worksheetId,
    ['queued', 'processing'],
    { status: 'awaiting_review' },
  )

  /*
   * spec.md:611's completion notification, on the transition that delivered it.
   *
   * Guarded on the transition rather than fired unconditionally, because this
   * handler also runs for the `answer_key` stage, which completes against a
   * worksheet already sitting at `awaiting_review`. Announcing that one would
   * tell a student their worksheet was ready a second time, an hour after they
   * checked it.
   */
  if (delivered) {
    await notifyWorksheet(db, job.userId, job.worksheetId, 'worksheet_ready')
  }

  /*
   * The answers follow the paper rather than holding it up.
   *
   * Working out every question is the better part of an hour on a long
   * paper, and the student wants to mark their work now. So extraction
   * completing is what makes the worksheet readable, and this queues the
   * solving behind it at low priority, where it yields to anybody else's
   * extraction.
   *
   * Only off an extract job, or a solving job completing would queue another
   * one and the worker would solve the same paper until somebody noticed.
   */
  /*
   * Not for Tier C, whose runner reads pages and nothing else yet.
   *
   * The executor also has to be inherited rather than written literally. This
   * said `'operator_gpu'`, which was true by context rather than by reasoning:
   * the worker route was the only caller. Tier B's own completion path already
   * enqueues its follow-up on `'server'` for this reason
   * (lib/worker/server-job.ts:251), and now a browser reaches this handler too,
   * where a literal would hand the operator's GPU the answer key for a paper it
   * never read, on behalf of the one tier that is meant to cost us no compute.
   *
   * And a `'browser'` answer-key job would be worse than useless: nothing
   * claims it, so it would sit pending until the reaper failed it, and the
   * student would watch a finished worksheet grow an error. Solving a long
   * paper is the better part of an hour with the tab held open, which wants
   * deciding on its own terms rather than inheriting extraction's.
   */
  if (job.stage === 'extract' && job.executor !== 'browser') {
    await enqueueJob(db, {
      worksheetId: job.worksheetId,
      userId: job.userId,
      stage: 'answer_key',
      executor: job.executor,
      priority: 'low',
    })
  }

  return NextResponse.json({ ok: true })
}

export async function handlePageResult(
  db: Db,
  jobId: string,
  job: Job,
  body: Action<'page_result'>,
): Promise<NextResponse> {
  const [page] = await db
    .select({ id: worksheetPages.id, worksheetId: worksheetPages.worksheetId })
    .from(worksheetPages)
    .where(eq(worksheetPages.id, body.pageId))
    .limit(1)

  if (!page || page.worksheetId !== job.worksheetId) {
    return NextResponse.json({ error: 'Page does not belong to this job' }, { status: 400 })
  }

  const created = await persistQuestions(db, job, page.id, body.questions)

  // Recorded as a set rather than a high-water mark. With more than one page
  // in flight they finish out of order, so "everything up to N is done" would
  // be a lie, and a resumed job would skip whatever was still running below N.
  const previous = (job.checkpoint as { donePages?: number[] } | null)?.donePages ?? []
  const donePages = [...new Set([...previous, body.pageNumber])].sort((a, b) => a - b)

  await checkpointJob(
    db,
    jobId,
    readingProgress(donePages.length, body.totalPages),
    // lastPageNumber stays for a job enqueued before this shipped, whose
    // checkpoint has no donePages to read.
    { donePages, lastPageNumber: Math.max(...donePages) },
  )

  return NextResponse.json({
    ok: true,
    created,
    duplicates: body.questions.length - created,
  })
}
