import { and, eq, notInArray } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { db } from '@/lib/db'
import { questions } from '@/lib/db/schema'
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

  const exclude = parsed.data.exclude ?? []

  /*
   * One statement for the whole worksheet.
   *
   * The verify screen used to fire one PATCH per question behind this button,
   * which on the 114-question benchmark paper is 114 requests queued against a
   * five-connection pool, most of them still in flight when the student
   * navigates away.
   *
   * `notInArray` is only applied when there is something to exclude: with an
   * empty list it compiles to `id not in ()`, which is a syntax error rather
   * than a no-op.
   */
  const updated = await db
    .update(questions)
    .set({ userVerified: true })
    .where(
      and(
        eq(questions.worksheetId, worksheetId),
        eq(questions.userVerified, false),
        exclude.length > 0 ? notInArray(questions.id, exclude) : undefined,
      ),
    )
    .returning({ id: questions.id })

  return NextResponse.json({ verified: updated.length })
}
