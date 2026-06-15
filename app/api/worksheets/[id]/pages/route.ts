import { and, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { db } from '@/lib/db'
import { worksheetPages, worksheets } from '@/lib/db/schema'
import { pageImageKey, storage } from '@/lib/storage'
import { guardWorksheet } from '@/lib/upload/guard'
import { MAX_PAGE_BYTES, MAX_PAGE_DIMENSION } from '@/lib/upload/limits'

type Params = { params: Promise<{ id: string }> }

/** Accepts one rasterized page image from the browser. */
export async function POST(request: Request, { params }: Params) {
  const { id: worksheetId } = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({ error: 'Not found' }, { status: guard.status })
  }

  const form = await request.formData()
  const file = form.get('image')
  const pageNumber = Number(form.get('pageNumber'))
  const width = Number(form.get('width'))
  const height = Number(form.get('height'))

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing image' }, { status: 400 })
  }
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    return NextResponse.json({ error: 'Invalid page number' }, { status: 400 })
  }

  // Size and dimension caps are crash guards, so they apply to admins too.
  if (file.size > MAX_PAGE_BYTES) {
    return NextResponse.json({ error: 'Page image is too large' }, { status: 413 })
  }
  if (width > MAX_PAGE_DIMENSION || height > MAX_PAGE_DIMENSION) {
    return NextResponse.json({ error: 'Page image is too large' }, { status: 413 })
  }
  if (!file.type.startsWith('image/')) {
    return NextResponse.json({ error: 'Not an image' }, { status: 415 })
  }

  const key = pageImageKey(worksheetId, pageNumber)
  await storage.put(key, Buffer.from(await file.arrayBuffer()), file.type)

  const [page] = await db
    .insert(worksheetPages)
    .values({
      worksheetId,
      pageNumber,
      imageKey: key,
      width: Number.isFinite(width) ? width : null,
      height: Number.isFinite(height) ? height : null,
    })
    .onConflictDoUpdate({
      target: [worksheetPages.worksheetId, worksheetPages.pageNumber],
      set: { imageKey: key, width, height },
    })
    .returning({ id: worksheetPages.id })

  await db
    .update(worksheets)
    .set({ status: 'processing' })
    .where(eq(worksheets.id, worksheetId))

  return NextResponse.json({ pageId: page.id, imageKey: key }, { status: 201 })
}

const bboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()])

const ocrSchema = z.object({
  pageId: z.string().min(1),
  ocrText: z.string().max(200_000),
  ocrEngine: z.enum(['pdf_text', 'tesseract', 'vision']),
  textLines: z
    .array(z.object({ text: z.string().max(2000), bbox: bboxSchema }))
    .max(4000)
    .optional(),
})

/** Stores the text layer once the browser has OCR'd (or extracted) the page. */
export async function PATCH(request: Request, { params }: Params) {
  const { id: worksheetId } = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({ error: 'Not found' }, { status: guard.status })
  }

  const parsed = ocrSchema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const { pageId, ocrText, ocrEngine, textLines } = parsed.data

  await db
    .update(worksheetPages)
    .set({ ocrText, ocrEngine, textLines: textLines ?? null })
    .where(
      and(
        eq(worksheetPages.id, pageId),
        eq(worksheetPages.worksheetId, worksheetId),
      ),
    )

  return NextResponse.json({ ok: true })
}
