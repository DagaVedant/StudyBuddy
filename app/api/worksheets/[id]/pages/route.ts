import { and, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { db } from '@/lib/db'
import { worksheetPages, worksheets } from '@/lib/db/schema'
import { PAGE_UPLOAD_LIMIT, consumeRateLimit } from '@/lib/rate-limit'
import { pageImageKey, storage } from '@/lib/storage'
import { guardWorksheet } from '@/lib/upload/guard'
import { MAX_PAGE_BYTES, MAX_PAGE_DIMENSION } from '@/lib/upload/limits'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: Params) {
  const { id: worksheetId } = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({ error: 'Not found' }, { status: guard.status })
  }

  // Before the body is read, so a refused request does not first cost a 4 MB
  // upload. The worksheet limit counts worksheets, which are one cheap row
  // each; this is the call that writes to blob storage, and it was open.
  const allowance = await consumeRateLimit(
    db,
    PAGE_UPLOAD_LIMIT,
    `user:${guard.userId}`,
  )

  if (!allowance.ok) {
    return NextResponse.json(
      { error: "That's a lot of pages in one go. Try again shortly." },
      { status: 429, headers: { 'Retry-After': String(allowance.retryAfter) } },
    )
  }

  // Throws on a body that is not parseable multipart, which a client that got
  // its boundary or its Content-Type wrong sends. Folded into the missing-image
  // 400 below rather than left to become a 500: a body we cannot read carries no
  // image either, and the caller's fix is the same.
  const form = await request.formData().catch(() => null)
  if (!form) {
    return NextResponse.json({ error: 'Missing image' }, { status: 400 })
  }

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

  // Both clauses read the same guarded values. The update clause used to take
  // `width` and `height` raw while the insert clause guarded them, so a page
  // uploaded twice with a non-numeric width sent NaN to an integer column on
  // the second try: the first upload stored null and the conflict path then
  // failed the whole request. The columns are nullable because a photo upload
  // has no dimensions to report.
  const storedWidth = Number.isFinite(width) ? width : null
  const storedHeight = Number.isFinite(height) ? height : null

  const [page] = await db
    .insert(worksheetPages)
    .values({
      worksheetId,
      pageNumber,
      imageKey: key,
      width: storedWidth,
      height: storedHeight,
    })
    .onConflictDoUpdate({
      target: [worksheetPages.worksheetId, worksheetPages.pageNumber],
      set: { imageKey: key, width: storedWidth, height: storedHeight },
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

export async function PATCH(request: Request, { params }: Params) {
  const { id: worksheetId } = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({ error: 'Not found' }, { status: guard.status })
  }

  const parsed = ocrSchema.safeParse(await request.json().catch(() => null))
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
