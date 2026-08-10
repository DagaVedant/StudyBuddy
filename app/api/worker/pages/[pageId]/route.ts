import { and, eq, inArray } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { processingJobs, worksheetPages } from '@/lib/db/schema'
import { storage } from '@/lib/storage'
import { authenticateWorker } from '@/lib/worker/auth'

type Params = { params: Promise<{ pageId: string }> }

export async function GET(request: Request, { params }: Params) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status })
  }

  const { pageId } = await params

  const [page] = await db
    .select({
      imageKey: worksheetPages.imageKey,
      worksheetId: worksheetPages.worksheetId,
    })
    .from(worksheetPages)
    .where(eq(worksheetPages.id, pageId))
    .limit(1)

  if (!page) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const active = await db
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.worksheetId, page.worksheetId),
        eq(processingJobs.executor, 'operator_gpu'),
        inArray(processingJobs.status, ['claimed', 'running']),
      ),
    )
    .limit(1)

  if (active.length === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const object = await storage.getStream(page.imageKey)
  if (!object) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const headers = new Headers({
    'Content-Type': object.contentType,
    'Cache-Control': 'no-store',
  })

  if (object.size !== null) headers.set('Content-Length', String(object.size))

  return new NextResponse(object.stream, { headers })
}
