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

  const wanted = asked
    .split(',')
    .map((stage) => stage.trim())
    .filter((stage): stage is JobStage => (STAGES as string[]).includes(stage))

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

  return NextResponse.json({
    job: {
      id: job.id,
      worksheetId: job.worksheetId,
      stage: job.stage,
      attemptCount: job.attemptCount,
      title: worksheet?.title ?? null,
      expectedQuestionCount: worksheet?.expectedQuestionCount ?? null,
      checkpoint: job.checkpoint,
    },
    ...(job.stage === 'extract'
      ? {pages: await pagesForJob(db, job.worksheetId)}
      : {}),
    ...(job.stage === 'answer_key'
      ? {solve: await unsolvedQuestions(db, job.worksheetId)}
      : {}),
    ...(job.stage === 'explain' && questionId
      ? {explain: await explainInput(db, userId, questionId)}
      : {}),
    ollama,
  })
}

export {postClaim as POST}
