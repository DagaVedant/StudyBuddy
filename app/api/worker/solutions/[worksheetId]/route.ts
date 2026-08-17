import { NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { authenticateWorker } from '@/lib/worker/auth'
import { unsolvedQuestions } from '@/lib/worker/solutions'

type Params = { params: Promise<{ worksheetId: string }> }

export async function GET(request: Request, { params }: Params) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status })
  }

  const { worksheetId } = await params

  return NextResponse.json({ questions: await unsolvedQuestions(db, worksheetId) })
}
