import { and, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { worksheetPages } from '@/lib/db/schema'
import { roundLines } from '@/lib/questions/text-lines'
import { guardWorksheet } from '@/lib/upload/guard'

type Params = { params: Promise<{ id: string; pageId: string }> }

/**
 * What the review screen's drag reads for every page after the first
 * (app/(app)/worksheets/[id]/review/page.tsx only sends page one's lines up
 * front). Scoped to both the worksheet and the page, not just the page id,
 * so a signed-in student cannot walk another account's page ids and read
 * their OCR text.
 */
export async function GET(_request: Request, { params }: Params) {
  const { id: worksheetId, pageId } = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({ error: 'Not found' }, { status: guard.status })
  }

  const [row] = await db
    .select({ textLines: worksheetPages.textLines })
    .from(worksheetPages)
    .where(and(eq(worksheetPages.id, pageId), eq(worksheetPages.worksheetId, worksheetId)))
    .limit(1)

  if (!row) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  return NextResponse.json({ textLines: roundLines(row.textLines) })
}
