import { and, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { worksheetPages, worksheets } from '@/lib/db/schema'
import { storage } from '@/lib/storage'

type Params = { params: Promise<{ id: string }> }

/**
 * Matches the title the upload form accepts, so a worksheet cannot be renamed
 * to something it could not have been called when it was created.
 */
const renameSchema = z.object({
  title: z.string().trim().min(1).max(200),
})

/**
 * Rename a worksheet.
 *
 * The title is set once at upload and defaults to the filename with its
 * extension stripped, so a student who uploads `scan_002.pdf` had a worksheet
 * called `scan_002` for as long as they kept it. It is also the only handle on
 * that worksheet in three separate lists, and now in a search box, which makes
 * a filename from a scanner the thing they have to recognise it by.
 */
export async function PATCH(request: Request, { params }: Params) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params

  const parsed = renameSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'A title has to be between 1 and 200 characters.' },
      { status: 400 },
    )
  }

  // Scoped in the statement rather than checked first. A read followed by a
  // write is two round trips and a race; this is one, and a worksheet that is
  // not theirs updates nothing and reports so.
  const [updated] = await db
    .update(worksheets)
    .set({ title: parsed.data.title })
    .where(and(eq(worksheets.id, id), eq(worksheets.userId, session.user.id)))
    .returning({ id: worksheets.id, title: worksheets.title })

  if (!updated) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  return NextResponse.json({ ok: true, title: updated.title })
}

export async function DELETE(_request: Request, { params }: Params) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params

  const [worksheet] = await db
    .select({ userId: worksheets.userId })
    .from(worksheets)
    .where(eq(worksheets.id, id))
    .limit(1)

  if (!worksheet || worksheet.userId !== session.user.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const pageKeys = await db
    .select({ imageKey: worksheetPages.imageKey })
    .from(worksheetPages)
    .where(eq(worksheetPages.worksheetId, id))

  // The row delete cascades every dependent table (pages, questions, answer
  // choices, attempts, review cards, jobs; see lib/db/schema.ts). Stored
  // files aren't part of that, so they're removed after, best-effort: an
  // orphaned blob is a smaller problem than a worksheet that won't delete
  // because a file happened to already be gone.
  await db.delete(worksheets).where(eq(worksheets.id, id))

  await Promise.allSettled(pageKeys.map((page) => storage.remove(page.imageKey)))

  return NextResponse.json({ ok: true })
}
