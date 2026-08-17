import { NextResponse } from 'next/server'

import { auth } from '@/auth'
import { blooketDownload } from '@/lib/blooket/download'
import { getMissedQuestions } from '@/lib/blooket/missed'
import { db } from '@/lib/db'

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  return blooketDownload(await getMissedQuestions(db, session.user.id))
}
