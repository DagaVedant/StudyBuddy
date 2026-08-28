import {NextResponse} from 'next/server'
import {asc, eq} from 'drizzle-orm'
import {answerChoices, questions, questionTopics} from '@/lib/schema'
import {checkReferences, CHOICE_ORDER, referenceError} from '@/lib/questions/queries'
import {guardWorksheet} from '@/lib/queue'
import {guardRateLimit, QUESTION_WRITE_LIMIT, readJson} from '@/lib/api'
import {db} from '@/lib/db'
import {hashQuestion, questionInputSchema} from '@/lib/questions/shape'

export async function GET(_request: Request, {params}: {params: Promise<Record<string, string>>}) {
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

  const choicesFor = new Map<string, (typeof answerChoices.$inferSelect)[]>()

  for (const row of choices) {
    const choice = row.answer_choices

    let list = choicesFor.get(choice.questionId)

    if (!list) {
      list = []
      choicesFor.set(choice.questionId, list)
    }

    list.push(choice)
  }

  const topicFor = new Map<string, string>()
  for (const row of topics) {
    if (!topicFor.has(row.question_topics.questionId)) {
      topicFor.set(row.question_topics.questionId, row.question_topics.topicId)
    }
  }

  const listed = []

  for (const question of rows) {
    let questionChoices = choicesFor.get(question.id)
    if (!questionChoices) questionChoices = []

    let topicId = null
    const found = topicFor.get(question.id)
    if (found) topicId = found

    listed.push({...question, choices: questionChoices, topicId: topicId})
  }

  return NextResponse.json({questions: listed})
}

export async function POST(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const {id: worksheetId} = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({error: 'Not found'}, {status: guard.status})
  }

  const limited = await guardRateLimit(
    db,
    QUESTION_WRITE_LIMIT,
    'user:' + guard.userId,
    "That's a lot of questions in one go. Try again shortly.",
  )
  if (limited) return limited

  const parsed = questionInputSchema.safeParse(await readJson(request))
  if (!parsed.success) {
    let message = 'Invalid question'

    const issue = parsed.error.issues[0]
    if (issue && issue.message) message = issue.message

    return NextResponse.json({error: message}, {status: 400})
  }

  const input = parsed.data

  let choices = input.choices
  if (!choices) choices = []

  const references = await checkReferences(db, worksheetId, input)
  if (!references.ok) {
    return NextResponse.json({error: referenceError(references.field)}, {status: 400})
  }

  const contentHash = hashQuestion(input.promptText, choices)

  let pageId = null
  if (input.pageId) pageId = input.pageId

  let bbox = null
  if (input.bbox) bbox = input.bbox

  let correctAnswer = null
  let answerSource: 'user_key' | 'none' = 'none'

  if (input.correctAnswer) {
    correctAnswer = input.correctAnswer
    answerSource = 'user_key'
  }

  const questionId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(questions)
      .values({
        userId: guard.userId,
        worksheetId,
        pageId: pageId,
        ordinal: input.ordinal,
        promptText: input.promptText,
        questionType: input.questionType,
        bbox: bbox,
        correctAnswer: correctAnswer,
        answerSource: answerSource,
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
