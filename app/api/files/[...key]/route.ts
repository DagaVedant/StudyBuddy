import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { worksheets } from '@/lib/db/schema'
import { storage } from '@/lib/storage'

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

  if (!worksheet || worksheet.userId !== session.user.id) {
    return new NextResponse('Not found', { status: 404 })
  }

  // Streamed rather than buffered: this route only passes the bytes along, and
  // holding a 4 MB scan resident to do that cost about twice that per request
  // in flight, since the Uint8Array copy is a second allocation.
  const object = await storage.getStream(segments.join('/'))
  if (!object) {
    return new NextResponse('Not found', { status: 404 })
  }

  const headers = new Headers({
    'Content-Type': object.contentType,
    'Cache-Control': 'private, max-age=3600',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
  })

  // Only when the driver knows it. A wrong Content-Length truncates the image.
  if (object.size !== null) headers.set('Content-Length', String(object.size))

  return new NextResponse(object.stream, { headers })
}
