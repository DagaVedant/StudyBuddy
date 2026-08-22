import {NextResponse} from 'next/server'
import {eq} from 'drizzle-orm'

import {auth} from '@/auth'
import {db} from '@/lib/db'
import {storage} from '@/lib/queue'
import {worksheets} from '@/lib/schema'

export async function GET(
  _request: Request,
  {params}: {params: Promise<{key: string[]}>},
) {
  const session = await auth()
  if (!session?.user?.id) {
    return new NextResponse('Unauthorized', {status: 401})
  }

  const {key: segments} = await params
  const [scope, worksheetId] = segments

  if ((scope !== 'pages' && scope !== 'figures') || !worksheetId) {
    return new NextResponse('Not found', {status: 404})
  }

  const [worksheet] = await db
    .select({userId: worksheets.userId})
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  if (!worksheet || worksheet.userId !== session.user.id) {
    return new NextResponse('Not found', {status: 404})
  }

  const object = await storage.getStream(segments.join('/'))
  if (!object) {
    return new NextResponse('Not found', {status: 404})
  }

  const headers = new Headers({
    'Content-Type': object.contentType,
    'Cache-Control': 'private, max-age=3600',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
  })

  if (object.size !== null) headers.set('Content-Length', String(object.size))

  return new NextResponse(object.stream, {headers})
}
