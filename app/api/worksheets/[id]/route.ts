import { and, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { worksheetPages, worksheets } from '@/lib/db/schema'
import { WORKSHEET_WRITE_LIMIT, guardRateLimit } from '@/lib/rate-limit'
import { storage } from '@/lib/storage'

type Params = { params: Promise<{ id: string }> }

const renameSchema = z.object({
  title: z.string().trim().min(1).max(200),
})

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

  const limited = await guardRateLimit(
    db,
    WORKSHEET_WRITE_LIMIT,
    `user:${session.user.id}`,
    'Too many changes to your worksheets. Try again shortly.',
  )
  if (limited) return limited

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

  const limited = await guardRateLimit(
    db,
    WORKSHEET_WRITE_LIMIT,
    `user:${session.user.id}`,
    'Too many changes to your worksheets. Try again shortly.',
  )
  if (limited) return limited

  const pageKeys = await db
    .select({ imageKey: worksheetPages.imageKey })
    .from(worksheetPages)
    .where(eq(worksheetPages.worksheetId, id))

  await db.delete(worksheets).where(eq(worksheets.id, id))

  await Promise.allSettled(pageKeys.map((page) => storage.remove(page.imageKey)))

  return NextResponse.json({ ok: true })
}
