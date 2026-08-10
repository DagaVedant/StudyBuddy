import { NextResponse } from 'next/server'

import { auth } from '@/auth'
import { blooketDownload } from '@/lib/blooket/download'
import { getMissedQuestions } from '@/lib/blooket/missed'
import { db } from '@/lib/db'

/** Every question this student has missed. One paper's worth lives at `[worksheetId]`. */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  return blooketDownload(await getMissedQuestions(db, session.user.id))
}
