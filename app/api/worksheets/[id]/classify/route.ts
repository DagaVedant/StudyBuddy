import {NextResponse} from 'next/server'
import {readJson} from '@/lib/api'
import {and, eq} from 'drizzle-orm'
import {z} from 'zod'
import {questions, worksheets} from '@/lib/schema'
import {applyClassification, isEmbedding, pendingQuestionCount, pendingQuestions, settledByEmbedding, shortlistByVector} from '@/lib/taxonomy'
import {guardWorksheet} from '@/lib/queue'
import {resolveProvider} from '@/lib/ai/resolve'
import {clearUntagged} from '@/lib/worker/apply'
import {db} from '@/lib/db'

export const maxDuration = 300

const CLASSIFY_BATCH = 12

const schema = z.object({
  items: z
    .array(
      z.object({questionId: z.string().min(1), embedding: z.array(z.number())}),
    )
    .max(CLASSIFY_BATCH),
})

type Params = {params: Promise<{id: string}>}

async function ownedQuestion(worksheetId: string, userId: string, questionId: string) {
  const [question] = await db
    .select({id: questions.id, promptText: questions.promptText, userId: questions.userId})
    .from(questions)
    .where(
      and(
        eq(questions.id, questionId),
        eq(questions.worksheetId, worksheetId),
        eq(questions.userId, userId),
      ),
    )
    .limit(1)

  return question
}

async function finish(worksheetId: string) {
  const remaining = await pendingQuestions(db, worksheetId, 1)

  if (remaining.length === 0) {
    await clearUntagged(db, worksheetId)
  }

  return remaining.length === 0
}

export async function GET(_request: Request, {params}: Params) {
  const {id: worksheetId} = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({error: 'Not found'}, {status: guard.status})
  }

  const {executor} = await resolveProvider(db, guard.userId)

  const pending = await pendingQuestions(db, worksheetId, CLASSIFY_BATCH)
  const remaining = await pendingQuestionCount(db, worksheetId)

  if (remaining === 0) {
    await clearUntagged(db, worksheetId)
  }

  return NextResponse.json({
    supported: executor === 'server',
    executor,
    batchSize: CLASSIFY_BATCH,
    remaining,
    questions: pending,
  })
}

export async function POST(request: Request, {params}: Params) {
  const {id: worksheetId} = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({error: 'Not found'}, {status: guard.status})
  }

  const parsed = schema.safeParse(await readJson(request))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const body = parsed.data
  const {provider, executor} = await resolveProvider(db, guard.userId)

  const [worksheet] = await db
    .select({subjectHint: worksheets.subjectHint})
    .from(worksheets)
    .where(eq(worksheets.id, worksheetId))
    .limit(1)

  if (!worksheet) {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  if (executor !== 'server') {
    return NextResponse.json(
      {
        error:
          'Nothing is set up to sort topics for this account. Connect your own AI provider in settings.',
      },
      {status: 409},
    )
  }

  let applied = 0
  let coarse = 0
  let failed = 0

  for (const item of body.items) {
    if (!isEmbedding(item.embedding)) {
      failed += 1
      continue
    }

    const question = await ownedQuestion(worksheetId, guard.userId, item.questionId)
    if (!question) continue

    await db
      .update(questions)
      .set({embedding: item.embedding})
      .where(eq(questions.id, question.id))

    const candidates = await shortlistByVector(db, item.embedding, {
      subjectHint: worksheet.subjectHint,
    })

    if (candidates.length === 0) {
      failed += 1
      continue
    }

    try {
      let classification = null

      const settled = settledByEmbedding(candidates)
      if (settled) {
        classification = {
          topic_slug: settled.slug,
          confidence: settled.confidence,
          abstain: false,
        }
      } else {
        classification = await provider.classifyTopic(question.promptText, candidates)
      }

      const outcome = await applyClassification(
        db,
        question,
        candidates,
        classification,
      )

      if (outcome.topicId) applied += 1
      if (outcome.coarse) coarse += 1
    } catch (error) {
      failed += 1
      console.error(
        '[classify] question ' + question.id + ' could not be classified:',
        (error as Error).message,
      )
    }
  }

  return NextResponse.json({applied, coarse, failed, done: await finish(worksheetId)})
}
