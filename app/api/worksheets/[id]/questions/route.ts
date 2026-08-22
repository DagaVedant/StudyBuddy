import {NextResponse} from 'next/server'
import {asc, eq} from 'drizzle-orm'
import {answerChoices, questions, questionTopics} from '@/lib/schema'
import {checkReferences, CHOICE_ORDER, referenceError} from '@/lib/questions/queries'
import {guardWorksheet} from '@/lib/queue'
import {consumeRateLimit, QUESTION_WRITE_LIMIT} from '@/lib/api'
import {db} from '@/lib/db'
import {hashQuestion, questionInputSchema} from '@/lib/questions/shape'

async function getIdQuestions(_request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const {id: worksheetId} = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({error: 'Not found'}, {status: guard.status})
  }

  const rows = await db
    .select()
    .from(questions)
    .where(eq(questions.worksheetId, worksheetId))
    .orderBy(asc(questions.ordinal))

  const choices = await db
    .select()
    .from(answerChoices)
    .innerJoin(questions, eq(answerChoices.questionId, questions.id))
    .where(eq(questions.worksheetId, worksheetId))
    .orderBy(...CHOICE_ORDER)

  const topics = await db
    .select()
    .from(questionTopics)
    .innerJoin(questions, eq(questionTopics.questionId, questions.id))
    .where(eq(questions.worksheetId, worksheetId))

  const choicesFor = new Map<string, (typeof choices)[number]['answer_choices'][]>()
  for (const row of choices) {
    const list = choicesFor.get(row.answer_choices.questionId)
    if (list) list.push(row.answer_choices)
    else choicesFor.set(row.answer_choices.questionId, [row.answer_choices])
  }

  const topicFor = new Map<string, string>()
  for (const row of topics) {
    if (!topicFor.has(row.question_topics.questionId)) {
      topicFor.set(row.question_topics.questionId, row.question_topics.topicId)
    }
  }

  return NextResponse.json({
    questions: rows.map((question) => ({
      ...question,
      choices: choicesFor.get(question.id) ?? [],
      topicId: topicFor.get(question.id) ?? null,
    })),
  })
}

async function postIdQuestions(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const {id: worksheetId} = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({error: 'Not found'}, {status: guard.status})
  }

  const allowance = await consumeRateLimit(db, QUESTION_WRITE_LIMIT, `user:${guard.userId}`)

  if (!allowance.ok) {
    return NextResponse.json(
      {error: "That's a lot of questions in one go. Try again shortly."},
      {status: 429, headers: {'Retry-After': String(allowance.retryAfter)}},
    )
  }

  const parsed = questionInputSchema.safeParse(
    await request.json().catch(() => null),
  )
  if (!parsed.success) {
    return NextResponse.json(
      {error: parsed.error.issues[0]?.message ?? 'Invalid question'},
      {status: 400},
    )
  }

  const input = parsed.data
  const choices = input.choices ?? []

  const references = await checkReferences(db, worksheetId, input)
  if (!references.ok) {
    return NextResponse.json(
      {error: referenceError(references.field!)},
      {status: 400},
    )
  }

  const contentHash = hashQuestion(input.promptText, choices)

  const questionId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(questions)
      .values({
        userId: guard.userId,
        worksheetId,
        pageId: input.pageId ?? null,
        ordinal: input.ordinal,
        promptText: input.promptText,
        questionType: input.questionType,
        bbox: input.bbox ?? null,
        correctAnswer: input.correctAnswer ?? null,
        answerSource: input.correctAnswer ? 'user_key' : 'none',
        userVerified: true,
        contentHash,
      })
      .returning({id: questions.id})

    if (choices.length > 0) {
      await tx.insert(answerChoices).values(
        choices.map((choice) => ({
          questionId: row.id,
          label: choice.label,
          text: choice.text,
          isCorrect: choice.isCorrect,
        })),
      )
    }

    if (input.topicId) {
      await tx.insert(questionTopics).values({
        questionId: row.id,
        topicId: input.topicId,
        assignedBy: 'user',
        isPrimary: true,
        confidence: 1,
      })
    }

    return row.id
  })

  return NextResponse.json({questionId}, {status: 201})
}

export {getIdQuestions as GET}

export {postIdQuestions as POST}
