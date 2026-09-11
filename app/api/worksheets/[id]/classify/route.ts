import {NextResponse} from 'next/server'
import {readJson} from '@/lib/api'
import {and, eq} from 'drizzle-orm'
import {z} from 'zod'
import {questions, worksheets} from '@/lib/schema'
import {applyClassification, isEmbedding, pendingQuestionCount, pendingQuestions, shortlistByVector} from '@/lib/taxonomy'
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

  const shortlisted = []

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

    shortlisted.push({question: question, candidates: candidates})
  }

  if (shortlisted.length > 0) {
    const inputs = []

    for (let index = 0; index < shortlisted.length; index++) {
      inputs.push({
        index: index,
        promptText: shortlisted[index].question.promptText,
        candidates: shortlisted[index].candidates,
      })
    }

    try {
      const results = await provider.classifyBatch(inputs)

      const byIndex = new Map<number, (typeof results)[number]>()
      for (const result of results) {
        if (!byIndex.has(result.index)) byIndex.set(result.index, result)
      }

      for (let index = 0; index < shortlisted.length; index++) {
        const entry = shortlisted[index]
        const result = byIndex.get(index)

        if (!result) {
          failed += 1
          continue
        }

        const outcome = await applyClassification(
          db,
          entry.question,
          entry.candidates,
          result,
        )

        if (outcome.topicId) applied += 1
        if (outcome.coarse) coarse += 1
      }
    } catch (error) {
      failed += shortlisted.length
      console.error(
        '[classify] a batch of ' + shortlisted.length + ' on ' + worksheetId + ' failed:',
        (error as Error).message,
      )
    }
  }

  return NextResponse.json({applied, coarse, failed, done: await finish(worksheetId)})
}
