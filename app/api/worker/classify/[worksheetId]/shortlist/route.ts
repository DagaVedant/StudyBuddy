import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { isEmbedding, shortlistByVector } from '@/lib/classify'
import { db } from '@/lib/db'
import { worksheets } from '@/lib/db/schema'
import { authenticateWorker } from '@/lib/worker/auth'

type Params = { params: Promise<{ worksheetId: string }> }

const schema = z.object({
  items: z
    .array(
      z.object({
        questionId: z.string().min(1),
        embedding: z.array(z.number()),
      }),
    )
    .max(100),
})

/**
 * Turns embeddings the worker computed into topic shortlists.
 *
 * The vector arrives already computed because this host cannot load the
 * embedding model; the nearest-neighbour search itself is only pgvector, so
 * it runs here happily. Anything that is not a clean vector of the expected
 * width is dropped rather than reaching the query.
 */
export async function POST(request: Request, { params }: Params) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status })
  }

  const { worksheetId } = await params
  const parsed = schema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const [worksheet] = await db
    .select({ subjectHint: worksheets.subjectHint })
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  if (!worksheet) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const batch = []

  for (const item of parsed.data.items) {
    if (!isEmbedding(item.embedding)) continue

    batch.push({
      questionId: item.questionId,
      candidates: await shortlistByVector(db, item.embedding, worksheet.subjectHint),
    })
  }

  return NextResponse.json({ batch })
}
