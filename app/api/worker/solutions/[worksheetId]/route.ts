import {NextResponse} from 'next/server'
import {authenticateWorker} from '@/lib/worker/jobs'
import {db} from '@/lib/db'
import {unsolvedQuestions} from '@/lib/worker/solutions'

export async function GET(request: Request, {params}: {params: Promise<{worksheetId: string}>}) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({error: auth.message}, {status: auth.status})
  }

  const {worksheetId} = await params

  return NextResponse.json({questions: await unsolvedQuestions(db, worksheetId)})
}
