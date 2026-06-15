import { count, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { questions, worksheets } from '@/lib/db/schema'
import { guardWorksheet } from '@/lib/upload/guard'

type Params = { params: Promise<{ id: string }> }

/**
 * Closes extraction review (spec §4 stage 5). Nothing counts as a real
 * question until the student confirms here — this is the gate that keeps bad
 * extraction out of the dashboard.
 */
export async function POST(_request: Request, { params }: Params) {
  const { id: worksheetId } = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({ error: 'Not found' }, { status: guard.status })
  }

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

  await db
    .update(worksheets)
    .set({ status: 'ready' })
    .where(eq(worksheets.id, worksheetId))

  return NextResponse.json({ ok: true, next: `/worksheets/${worksheetId}/markup` })
}
