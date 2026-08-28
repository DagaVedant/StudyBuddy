import {NextResponse} from 'next/server'
import {readJson} from '@/lib/api'
import {eq} from 'drizzle-orm'
import {z} from 'zod'
import {applyClassification, pendingQuestions} from '@/lib/taxonomy'
import {authenticateWorker} from '@/lib/worker/jobs'
import {questions, worksheets} from '@/lib/schema'
import {clearUntagged} from '@/lib/worker/apply'
import {classificationSchema} from '@/lib/ai/types'
import {db} from '@/lib/db'

export async function GET(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({error: auth.message}, {status: auth.status})
  }

  const {worksheetId} = await params

  const [worksheet] = await db
    .select({subjectHint: worksheets.subjectHint})
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  if (!worksheet) {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  return NextResponse.json({
    subjectHint: worksheet.subjectHint,
    questions: await pendingQuestions(db, worksheetId),
  })
}

const candidateSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
})

const resultsSchema = z.object({
  results: z
    .array(
      z.object({
        questionId: z.string().min(1),
        classification: classificationSchema,
        candidates: z.array(candidateSchema).max(64),
      }),
    )
    .max(100),
})

export async function POST(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({error: auth.message}, {status: auth.status})
  }

  const {worksheetId} = await params
  const parsed = resultsSchema.safeParse(await readJson(request))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const [worksheet] = await db
    .select({id: worksheets.id})
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  if (!worksheet) {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  let applied = 0
  let coarse = 0

  for (const entry of parsed.data.results) {
    const [question] = await db
      .select({
        id: questions.id,
        promptText: questions.promptText,
        userId: questions.userId,
        worksheetId: questions.worksheetId,
      })
      .from(questions)
      .where(eq(questions.id, entry.questionId))
      .limit(1)

    if (!question || question.worksheetId !== worksheetId) continue

    try {
      const outcome = await applyClassification(
        db,
        question,
        entry.candidates,
        entry.classification,
      )
      if (outcome.topicId) applied += 1
      if (outcome.coarse) coarse += 1
    } catch (cause) {
      console.error('[classify] ' + entry.questionId + ' could not be applied:', cause)
    }
  }

  const remaining = await pendingQuestions(db, worksheetId, 1)
  const done = remaining.length === 0

  if (done) await clearUntagged(db, worksheetId)

  return NextResponse.json({ok: true, applied, coarse, done})
}
