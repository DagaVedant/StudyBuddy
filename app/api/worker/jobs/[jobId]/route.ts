import { and, eq, inArray } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { refundTrial } from '@/lib/ai/quota'
import { extractedQuestionSchema } from '@/lib/ai/types'
import type { Db } from '@/lib/dashboard/queries'
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
import { mergeDuplicateQuestions } from '@/lib/worker/dedupe'
import { renumberQuestions } from '@/lib/worker/renumber'
import { persistQuestions } from '@/lib/worker/ingest'
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

  const client = db as unknown as Db

  const [job] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId))
    .limit(1)

  if (!job) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const body = parsed.data

  if (body.action === 'fail') {
    const { permanent } = await failJob(client, jobId, body.message)

    if (permanent) {
      const [worksheet] = await db
        .select({ pageCount: worksheets.pageCount, tierUsed: worksheets.tierUsed })
        .from(worksheets)
        .where(eq(worksheets.id, job.worksheetId))
        .limit(1)

      if (worksheet?.tierUsed === 'trial') {
        await refundTrial(client, job.userId, 'worksheets', 1)
      }

      await db
        .update(worksheets)
        .set({ status: 'failed' })
        .where(eq(worksheets.id, job.worksheetId))
    }

    return NextResponse.json({ ok: true, permanent })
  }

  if (body.action === 'phase') {
    // Done before the audit reads the numbering, so it audits a repaired run
    // rather than chasing a gap a phantom row created.
    if (body.phase === 'verifying') {
      const { merged } = await mergeDuplicateQuestions(client, job.worksheetId)
      if (merged > 0) {
        console.log(`[dedupe] folded ${merged} duplicate question(s) on ${job.worksheetId}`)
      }

      // After the merge, so it numbers what survives rather than leaving a
      // hole where a folded row used to be.
      const { renumbered } = await renumberQuestions(client, job.worksheetId)
      if (renumbered > 0) {
        console.log(`[renumber] reordered ${renumbered} question(s) on ${job.worksheetId}`)
      }
    }

    await checkpointJob(
      client,
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
      .select({ id: worksheetPages.id, worksheetId: worksheetPages.worksheetId })
      .from(worksheetPages)
      .where(eq(worksheetPages.id, body.pageId))
      .limit(1)

    if (!target || target.worksheetId !== job.worksheetId) {
      return NextResponse.json({ error: 'Page does not belong to this job' }, { status: 400 })
    }

    const suspects = body.replace.length
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

    // Only drop a doubted question when the second read actually came back
    // with that number. Otherwise the review would turn a question that is
    // merely damaged into one that is missing, which is strictly worse.
    const refound = new Set(
      body.questions.map((question) => question.ordinal).filter((n) => n >= 1),
    )
    const replaceable = suspects.filter(
      (row) => row.printedNumber !== null && refound.has(row.printedNumber),
    )

    if (replaceable.length > 0) {
      await db.delete(questions).where(
        inArray(
          questions.id,
          replaceable.map((row) => row.id),
        ),
      )
    }

    const restored = await persistQuestions(client, job, target.id, body.questions)

    return NextResponse.json({
      ok: true,
      replaced: replaceable.length,
      kept: suspects.length - replaceable.length,
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
    await completeJob(client, jobId)
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

  const created = await persistQuestions(client, job, page.id, body.questions)

  // Recorded as a set rather than a high-water mark. With more than one page
  // in flight they finish out of order, so "everything up to N is done" would
  // be a lie, and a resumed job would skip whatever was still running below N.
  const previous = (job.checkpoint as { donePages?: number[] } | null)?.donePages ?? []
  const donePages = [...new Set([...previous, body.pageNumber])].sort((a, b) => a - b)

  await checkpointJob(
    client,
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
