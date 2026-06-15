import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { worksheets } from '@/lib/db/schema'
import { storage } from '@/lib/storage'

/**
 * Every page image and figure crop is served through here so ownership is
 * checked on each read (spec §8). Storage keys are namespaced by worksheet,
 * which is what makes the check a single lookup.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string[] }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  const { key: segments } = await params
  const [scope, worksheetId] = segments

  if ((scope !== 'pages' && scope !== 'figures') || !worksheetId) {
    return new NextResponse('Not found', { status: 404 })
  }

  const [worksheet] = await db
    .select({ userId: worksheets.userId })
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  // 404 rather than 403: don't confirm that someone else's worksheet exists.
  if (!worksheet || worksheet.userId !== session.user.id) {
    return new NextResponse('Not found', { status: 404 })
  }

  const object = await storage.get(segments.join('/'))
  if (!object) {
    return new NextResponse('Not found', { status: 404 })
  }

  return new NextResponse(new Uint8Array(object.body), {
    headers: {
      'Content-Type': object.contentType,
      'Content-Length': String(object.body.byteLength),
      'Cache-Control': 'private, max-age=3600',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
