import { NextResponse } from 'next/server'
import { z } from 'zod'

import { db } from '@/lib/db'
import { unverifyQuestions, verifyRemaining } from '@/lib/questions/verify-all'
import { guardWorksheet } from '@/lib/upload/guard'

type Params = { params: Promise<{ id: string }> }

const verifyAllSchema = z.object({
  /**
   * Questions the student has deliberately left unchecked on screen. Everything
   * else on the worksheet that is still unverified gets marked.
   */
  // Bounded per element as well as in count. Question ids are uuids, so
  // nothing legitimate is longer, and a count cap alone still lets 500
  // multi-megabyte strings be read and parsed before it can refuse them.
  exclude: z.array(z.string().min(1).max(64)).max(500).optional(),
})

export async function POST(request: Request, { params }: Params) {
  const { id: worksheetId } = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({ error: 'Not found' }, { status: guard.status })
  }

  // To null, not to `{}`. A body that failed to parse would otherwise arrive
  // here as "exclude nothing", which on this route means marking every
  // remaining question on the paper verified: the one outcome a malformed
  // request must not produce. Null fails the schema and returns 400 instead.
  const parsed = verifyAllSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const updated = await verifyRemaining(db, worksheetId, parsed.data.exclude ?? [])

  return NextResponse.json({ verified: updated.length })
}

const unverifySchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(500),
})

/** Undoes exactly what a batch accept just did. See lib/questions/verify-all.ts. */
export async function DELETE(request: Request, { params }: Params) {
  const { id: worksheetId } = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({ error: 'Not found' }, { status: guard.status })
  }

  const parsed = unverifySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const updated = await unverifyQuestions(db, worksheetId, parsed.data.ids)

  return NextResponse.json({ unverified: updated.length })
}
