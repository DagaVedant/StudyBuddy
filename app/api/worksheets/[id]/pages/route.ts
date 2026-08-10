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

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing image' }, { status: 400 })
  }

  // Bounded on its own, not against the worksheet's `pageCount`. Those measure
  // different things: with a page range the client rasterizes pages 10 to 15 of
  // a PDF and sends `pageCount: 6` alongside `pageNumber` 10 to 15, so tying
  // one to the other would refuse every ranged upload. Proven live before this
  // check existed: a worksheet declaring one page accepted seven, including
  // page 500 and page 99999.
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

  // How many pages this worksheet may hold, which is the half of the bound that
  // actually caps cost. Re-uploading a page number already stored replaces it
  // and is free, so only a new number counts against the declared total.
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

  // Decoded here rather than trusted. `width` and `height` used to be read from
  // form fields the client filled in, so the dimension guard was checking two
  // numbers rather than an image, `file.type` was whatever the client claimed,
  // and the bytes went to storage verbatim. The operator's home machine then
  // fed those exact bytes to sharp. Now the server is the first thing to decode
  // them, and what it stores is its own re-encode: anything that will not
  // decode is refused here instead of on somebody's GPU box.
  let encoded: Buffer
  let realWidth: number
  let realHeight: number

  // Imported at call time, not at module load. sharp binds libvips, and a
  // top-level import here put it into the prerender worker during
  // `next build`, where it collided with the image pipeline behind
  // `app/opengraph-image.tsx`: the build died on "colourspace: parameter space
  // not set" while rendering a page that has nothing to do with this route.
  // Same shape as lib/embeddings, and the same fix.
  const { default: sharp } = await import('sharp')

  try {
    const result = await sharp(Buffer.from(await file.arrayBuffer()), {
      limitInputPixels: MAX_DECODED_PIXELS,
    })
      // Honours EXIF orientation, which a phone photo carries and which the
      // model would otherwise read sideways.
      .rotate()
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true })

    encoded = result.data
    realWidth = result.info.width
    realHeight = result.info.height
  } catch {
    return NextResponse.json({ error: 'Not an image' }, { status: 415 })
  }

  // Measured after decoding, so this is the real size rather than a claim.
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

  // Only from the statuses that mean the upload is still happening. This used
  // to be unconditional, so a stray page POST against a finished worksheet
  // walked it backwards out of `ready` and the student watched a worksheet they
  // had already marked up return to the processing screen.
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
