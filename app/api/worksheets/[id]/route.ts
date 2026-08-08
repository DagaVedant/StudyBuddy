import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { worksheetPages, worksheets } from '@/lib/db/schema'
import { storage } from '@/lib/storage'

type Params = { params: Promise<{ id: string }> }

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
