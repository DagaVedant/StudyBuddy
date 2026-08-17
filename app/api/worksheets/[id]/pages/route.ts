import { and, eq, inArray } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { db } from '@/lib/db'
import { worksheetPages, worksheets } from '@/lib/db/schema'
import { PAGE_UPLOAD_LIMIT, consumeRateLimit } from '@/lib/rate-limit'
import { pageImageKey, storage } from '@/lib/storage'
import { guardWorksheet } from '@/lib/upload/guard'
import {
  MAX_DECODED_PIXELS,
  MAX_PAGE_BYTES,
  MAX_PAGE_DIMENSION,
  MAX_SOURCE_PAGE_NUMBER,
} from '@/lib/upload/limits'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: Params) {
  const { id: worksheetId } = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({ error: 'Not found' }, { status: guard.status })
  }

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

  const form = await request.formData().catch(() => null)
  if (!form) {
    return NextResponse.json({ error: 'Missing image' }, { status: 400 })
  }

  const file = form.get('image')
  const pageNumber = Number(form.get('pageNumber'))

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing image' }, { status: 400 })
  }

  if (
    !Number.isInteger(pageNumber) ||
    pageNumber < 1 ||
    pageNumber > MAX_SOURCE_PAGE_NUMBER
  ) {
    return NextResponse.json({ error: 'Invalid page number' }, { status: 400 })
  }

  if (file.size > MAX_PAGE_BYTES) {
    return NextResponse.json({ error: 'Page image is too large' }, { status: 413 })
  }

  const [sheet] = await db
    .select({ pageCount: worksheets.pageCount, status: worksheets.status })
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  if (!sheet) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const stored = await db
    .select({ pageNumber: worksheetPages.pageNumber })
    .from(worksheetPages)
    .where(eq(worksheetPages.worksheetId, worksheetId))

  const replacing = stored.some((row) => row.pageNumber === pageNumber)
  if (!replacing && stored.length >= sheet.pageCount) {
    return NextResponse.json(
      { error: 'That is more pages than this worksheet was created for.' },
      { status: 409 },
    )
  }

  let encoded: Buffer
  let realWidth: number
  let realHeight: number

  const { default: sharp } = await import('sharp')

  try {
    const result = await sharp(Buffer.from(await file.arrayBuffer()), {
      limitInputPixels: MAX_DECODED_PIXELS,
    })
      .rotate()
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true })

    encoded = result.data
    realWidth = result.info.width
    realHeight = result.info.height
  } catch {
    return NextResponse.json({ error: 'Not an image' }, { status: 415 })
  }

  if (realWidth > MAX_PAGE_DIMENSION || realHeight > MAX_PAGE_DIMENSION) {
    return NextResponse.json({ error: 'Page image is too large' }, { status: 413 })
  }

  const key = pageImageKey(worksheetId, pageNumber)
  await storage.put(key, encoded, 'image/webp')

  const [page] = await db
    .insert(worksheetPages)
    .values({
      worksheetId,
      pageNumber,
      imageKey: key,
      width: realWidth,
      height: realHeight,
    })
    .onConflictDoUpdate({
      target: [worksheetPages.worksheetId, worksheetPages.pageNumber],
      set: { imageKey: key, width: realWidth, height: realHeight },
    })
    .returning({ id: worksheetPages.id })

  if (sheet.status === 'uploading' || sheet.status === 'processing') {
    await db
      .update(worksheets)
      .set({ status: 'processing' })
      .where(
        and(
          eq(worksheets.id, worksheetId),
          inArray(worksheets.status, ['uploading', 'processing']),
        ),
      )
  }

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
