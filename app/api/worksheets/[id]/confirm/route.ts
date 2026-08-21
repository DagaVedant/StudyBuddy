import { count, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { questions, worksheets } from '@/lib/db/schema'
import { WORKSHEET_WRITE_LIMIT, guardRateLimit } from '@/lib/rate-limit'
import { transitionWorksheet } from '@/lib/queue'
import { guardWorksheet } from '@/lib/queue'

type Params = { params: Promise<{ id: string }> }

export async function POST(_request: Request, { params }: Params) {
  const { id: worksheetId } = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({ error: 'Not found' }, { status: guard.status })
  }

  const limited = await guardRateLimit(
    db,
    WORKSHEET_WRITE_LIMIT,
    `user:${guard.userId}`,
    'Too many changes to your worksheets. Try again shortly.',
  )
  if (limited) return limited

  const [tally] = await db
    .select({ value: count() })
    .from(questions)
    .where(eq(questions.worksheetId, worksheetId))

  if (!tally || tally.value === 0) {
    return NextResponse.json(
      { error: 'Add at least one question before continuing.' },
      { status: 400 },
    )
  }

  await db
    .update(questions)
    .set({ userVerified: true })
    .where(eq(questions.worksheetId, worksheetId))

  const next = `/worksheets/${worksheetId}/markup`

  if (await transitionWorksheet(db, worksheetId, ['awaiting_review'], { status: 'ready' })) {
    return NextResponse.json({ ok: true, next })
  }

  const [current] = await db
    .select({ status: worksheets.status })
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  if (current?.status === 'ready') {
    return NextResponse.json({ ok: true, next })
  }

  return NextResponse.json(
    { error: 'This worksheet is not ready to confirm.' },
    { status: 409 },
  )
}
