import { desc, eq } from 'drizzle-orm'
import { after, NextResponse } from 'next/server'
import { z } from 'zod'

import { auth } from '@/auth'
import { resolveProvider } from '@/lib/ai/resolve'
import { db } from '@/lib/db'
import { worksheets } from '@/lib/db/schema'
import { UPLOAD_LIMIT, consumeRateLimit } from '@/lib/rate-limit'
import { MAX_PAGES_PER_UPLOAD, pageCapFor } from '@/lib/upload/limits'
import { sweepAbandonedUploads } from '@/lib/upload/sweep'

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  sourceType: z.enum(['pdf_digital', 'pdf_scanned', 'photo', 'image']),
  subjectHint: z.string().trim().max(100).nullish(),
  pageCount: z.number().int().min(1).max(2000),
  expectedQuestionCount: z.number().int().min(1).max(2000).nullish(),
})

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Keyed by account rather than by IP: uploading needs a session, and a
  // shared school connection should not have one student's stack of homework
  // lock out everyone else on it.
  const allowance = await consumeRateLimit(
    db,
    UPLOAD_LIMIT,
    `user:${session.user.id}`,
  )

  if (!allowance.ok) {
    return NextResponse.json(
      { error: "That's a lot of uploads in one go. Try again shortly." },
      { status: 429, headers: { 'Retry-After': String(allowance.retryAfter) } },
    )
  }

  const parsed = createSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const { title, sourceType, subjectHint, pageCount, expectedQuestionCount } =
    parsed.data

  const cap = pageCapFor(session.user.role)
  if (pageCount > cap) {
    return NextResponse.json(
      {
        error: `That upload is ${pageCount} pages. The limit is ${MAX_PAGES_PER_UPLOAD} pages per upload.`,
      },
      { status: 413 },
    )
  }

  // Asked at upload time rather than read off the session. The session used to
  // carry a `users.ai_tier` column nothing ever wrote, so every worksheet was
  // stamped `trial` even when it ran on the student's own cloud key. This is
  // the same function that decides which provider actually runs the job, so
  // the record and the run cannot disagree.
  const { tier } = await resolveProvider(db, session.user.id)

  const [worksheet] = await db
    .insert(worksheets)
    .values({
      userId: session.user.id,
      title,
      sourceType,
      subjectHint: subjectHint ?? null,
      pageCount,
      expectedQuestionCount: expectedQuestionCount ?? null,
      status: 'uploading',
      tierUsed: tier,
    })
    .returning({ id: worksheets.id })

  // After the response, so it never slows an upload down. Cancel deletes what
  // it started; this is for the tab that was closed and the laptop that slept,
  // which leave a row in `uploading` with page images under it that nothing
  // will ever read. Scoped to this student, because there is no scheduler here
  // and their next upload is the cheapest moment to clear their own leftovers.
  after(async () => {
    try {
      const swept = await sweepAbandonedUploads(db, session.user.id)
      if (swept > 0) {
        console.log(`[upload] swept ${swept} abandoned upload(s) for ${session.user.id}`)
      }
    } catch (error) {
      // Never the caller's problem: their worksheet was created either way.
      console.error('[upload] sweep failed:', (error as Error).message)
    }
  })

  return NextResponse.json({ worksheetId: worksheet.id }, { status: 201 })
}

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const rows = await db
    .select({
      id: worksheets.id,
      title: worksheets.title,
      status: worksheets.status,
      pageCount: worksheets.pageCount,
      createdAt: worksheets.createdAt,
    })
    .from(worksheets)
    .where(eq(worksheets.userId, session.user.id))
    .orderBy(desc(worksheets.createdAt))
    .limit(50)

  return NextResponse.json({ worksheets: rows })
}
