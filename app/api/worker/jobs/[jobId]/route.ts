import { and, eq, inArray } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { extractedQuestionSchema } from '@/lib/ai/types'
import { db } from '@/lib/db'
import {
  explanations,
  processingJobs,
  questions,
  worksheetPages,
  worksheets,
} from '@/lib/db/schema'
import { checkpointJob, completeJob, failJob } from '@/lib/queue'
import { authenticateWorker } from '@/lib/worker/auth'
import { applyPermanentFailure } from '@/lib/worker/fail'
import { persistQuestions } from '@/lib/worker/ingest'
import { FINAL_PASSES, VERIFYING_PASSES, runRepairPasses } from '@/lib/worker/pipeline'
import { planPageReplacement } from '@/lib/worker/review'
import { partitionByDeletability } from '@/lib/worker/safe-delete'
import { CLASSIFYING_AT, VERIFYING_AT, readingProgress } from '@/lib/worker/progress'

type Params = { params: Promise<{ jobId: string }> }

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('page_result'),
    pageId: z.string().min(1),
    pageNumber: z.number().int().min(1),
    totalPages: z.number().int().min(1),
    questions: z.array(extractedQuestionSchema).max(100),
  }),
  // Moves the bar past page-reading once the worker starts a later stage, so
  // it does not sit at full while the audit and classification still run.
  z.object({
    action: z.literal('phase'),
    phase: z.enum(['verifying', 'classifying']),
  }),
  // A page read a second time because the review pass doubted some of what it
  // produced. Distinct from page_result: that one only ever adds, so a
  // corrected question would land beside the broken one instead of replacing
  // it, and the student would see both.
  z.object({
    action: z.literal('page_review'),
    pageId: z.string().min(1),
    replace: z.array(z.string().uuid()).max(100),
    questions: z.array(extractedQuestionSchema).max(100),
  }),
  z.object({
    action: z.literal('explanation'),
    questionId: z.string().uuid(),
    attemptId: z.string().uuid().nullish(),
    bodyMd: z.string().min(1).max(6000),
    misconceptionNote: z.string().max(400).nullish(),
    model: z.string().max(200),
  }),
  z.object({ action: z.literal('complete') }),
  z.object({ action: z.literal('fail'), message: z.string().max(2000) }),
])

export async function POST(request: Request, { params }: Params) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status })
  }

  const { jobId } = await params
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }


  const [job] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId))
    .limit(1)

  if (!job) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const body = parsed.data

  // The job has to still be live. A worker restarted mid-paper still holds the
  // job id it was working on, and nothing stopped it posting pages into a job
  // that had already completed or been reaped: questions appended to a finished
  // worksheet, or a `complete` that walked a failed one back to review.
  //
  // `fail` is exempt. A worker whose job was reaped out from under it is
  // reporting exactly the failure that happened, and refusing that report just
  // loses the error message.
  if (body.action !== 'fail' && job.status !== 'claimed' && job.status !== 'running') {
    return NextResponse.json(
      { error: `Job is ${job.status}, not accepting work`, status: job.status },
      { status: 409 },
    )
  }

  if (body.action === 'fail') {
    const { permanent } = await failJob(db, jobId, body.message)

    if (permanent) {
      await applyPermanentFailure(db, job)
    }

    return NextResponse.json({ ok: true, permanent })
  }

  if (body.action === 'phase') {
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

  if (body.action === 'page_review') {
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
            and(
              eq(questions.worksheetId, job.worksheetId),
              inArray(questions.id, body.replace),
            ),
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

  if (body.action === 'explanation') {
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

  if (body.action === 'complete') {
    await completeJob(db, jobId)
    await db
      .update(worksheets)
      .set({ status: 'awaiting_review' })
      .where(eq(worksheets.id, job.worksheetId))

    return NextResponse.json({ ok: true })
  }


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
