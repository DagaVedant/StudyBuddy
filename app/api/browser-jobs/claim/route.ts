import {NextResponse} from 'next/server'
import {eq} from 'drizzle-orm'
import {auth} from '@/auth'
import {claimJob, type JobStage, queueDepth} from '@/lib/queue'
import {db} from '@/lib/db'
import {explainInput, unsolvedQuestions} from '@/lib/worker/solutions'
import {ollamaConfig} from '@/lib/ai/ollama'
import {pagesForJob} from '@/lib/worker/pipeline'
import {worksheets} from '@/lib/schema'

const STAGES: JobStage[] = ['extract', 'answer_key', 'explain']

function wantedStages(request: Request): JobStage[] | null {
  const asked = new URL(request.url).searchParams.get('stages')
  if (!asked) return null

  const names = asked.split(',').map((name) => name.trim())
  const wanted = STAGES.filter((stage) => names.includes(stage))

  return wanted.length > 0 ? wanted : null
}

async function postClaim(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({error: 'Unauthorized'}, {status: 401})
  }

  const userId = session.user.id

  const ollama = await ollamaConfig(db, userId)

  if (!ollama) {
    return NextResponse.json({error: 'No Ollama is configured.'}, {status: 409})
  }

  const job = await claimJob(db, 'browser', null, new Date(), userId, wantedStages(request))

  if (!job) {
    return NextResponse.json({job: null, depth: await queueDepth(db, 'browser')})
  }

  const [worksheet] = await db
    .select({
      title: worksheets.title,
      expectedQuestionCount: worksheets.expectedQuestionCount,
    })
    .from(worksheets)
    .where(eq(worksheets.id, job.worksheetId))
    .limit(1)

  const questionId = (job.checkpoint as {questionId?: string} | null)?.questionId

  const payload: Record<string, unknown> = {
    job: {
      id: job.id,
      worksheetId: job.worksheetId,
      stage: job.stage,
      attemptCount: job.attemptCount,
      title: worksheet?.title ?? null,
      expectedQuestionCount: worksheet?.expectedQuestionCount ?? null,
      checkpoint: job.checkpoint,
    },
  }

  if (job.stage === 'extract') {
    payload.pages = await pagesForJob(db, job.worksheetId)
  }

  if (job.stage === 'answer_key') {
    payload.solve = await unsolvedQuestions(db, job.worksheetId)
  }

  if (job.stage === 'explain' && questionId) {
    payload.explain = await explainInput(db, userId, questionId)
  }

  payload.ollama = ollama

  return NextResponse.json(payload)
}

export {postClaim as POST}
