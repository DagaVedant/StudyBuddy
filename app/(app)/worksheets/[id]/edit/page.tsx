import {asc, eq} from 'drizzle-orm'
import Link from 'next/link'
import {notFound, redirect} from 'next/navigation'

import {auth} from '@/auth'
import type {TopicChoice} from '@/components/topic-picker'
import {db} from '@/lib/db'
import {CHOICE_ORDER} from '@/lib/questions/queries'
import {roundLines} from '@/lib/questions/shape'
import {answerChoices, questionTopics, questions, topics, worksheetPages, worksheets} from '@/lib/schema'
import {pathBySlug} from '@/lib/taxonomy'

import EditClient, {type EditablePage, type EditableQuestion} from './edit-client'

export const metadata = {title: 'Edit Questions · StudyBuddy'}

async function leafTopics(): Promise<TopicChoice[]> {
  const paths = pathBySlug()

  const rows = await db
    .select({id: topics.id, slug: topics.slug, name: topics.name})
    .from(topics)
    .where(eq(topics.isLeaf, true))

  const listed = []

  for (const row of rows) {
    let path = paths.get(row.slug)
    if (!path) path = row.name

    listed.push({...row, path})
  }

  listed.sort(function (a, b) {
    if (a.path < b.path) return -1
    if (a.path > b.path) return 1

    return 0
  })

  return listed
}

export default async function EditPage({
  params,
  searchParams,
}: {
  params: Promise<{id: string}>
  searchParams: Promise<{focus?: string}>
}) {
  const {id} = await params
  const {focus} = await searchParams

  const session = await auth()
  if (!session || !session.user || !session.user.id) redirect('/signin')

  const [worksheet] = await db
    .select({
      userId: worksheets.userId,
      title: worksheets.title,
      expectedQuestionCount: worksheets.expectedQuestionCount,
    })
    .from(worksheets)
    .where(eq(worksheets.id, id))
    .limit(1)

  if (!worksheet || worksheet.userId !== session.user.id) notFound()

  const pageRows = await db
    .select({
      id: worksheetPages.id,
      pageNumber: worksheetPages.pageNumber,
      imageKey: worksheetPages.imageKey,
      width: worksheetPages.width,
      height: worksheetPages.height,
      textLines: worksheetPages.textLines,
    })
    .from(worksheetPages)
    .where(eq(worksheetPages.worksheetId, id))
    .orderBy(asc(worksheetPages.pageNumber))

  const questionRows = await db
    .select({
      id: questions.id,
      pageId: questions.pageId,
      ordinal: questions.ordinal,
      printedNumber: questions.printedNumber,
      promptText: questions.promptText,
      questionType: questions.questionType,
      bbox: questions.bbox,
      correctAnswer: questions.correctAnswer,
    })
    .from(questions)
    .where(eq(questions.worksheetId, id))
    .orderBy(asc(questions.ordinal))

  const choiceRows = await db
    .select({
      questionId: answerChoices.questionId,
      id: answerChoices.id,
      label: answerChoices.label,
      text: answerChoices.text,
      isCorrect: answerChoices.isCorrect,
    })
    .from(answerChoices)
    .innerJoin(questions, eq(answerChoices.questionId, questions.id))
    .where(eq(questions.worksheetId, id))
    .orderBy(...CHOICE_ORDER)

  const topicRows = await db
    .select({questionId: questionTopics.questionId, topicId: questionTopics.topicId})
    .from(questionTopics)
    .innerJoin(questions, eq(questionTopics.questionId, questions.id))
    .where(eq(questions.worksheetId, id))

  const pages: EditablePage[] = []

  for (let index = 0; index < pageRows.length; index++) {
    const page = pageRows[index]

    let width = 1000
    if (page.width) width = page.width

    let height = 1400
    if (page.height) height = page.height

    let textLines: ReturnType<typeof roundLines> = []
    if (index === 0) textLines = roundLines(page.textLines)

    pages.push({
      id: page.id,
      pageNumber: page.pageNumber,
      imageSrc: '/api/files/' + page.imageKey,
      width,
      height,
      textLines,
    })
  }

  const choicesFor = new Map<string, EditableQuestion['choices']>()

  for (const row of choiceRows) {
    const choice = {
      id: row.id,
      label: row.label,
      text: row.text,
      isCorrect: row.isCorrect,
    }

    let list = choicesFor.get(row.questionId)

    if (!list) {
      list = []
      choicesFor.set(row.questionId, list)
    }

    list.push(choice)
  }

  const topicFor = new Map<string, string>()
  for (const row of topicRows) {
    if (!topicFor.has(row.questionId)) topicFor.set(row.questionId, row.topicId)
  }

  const initialQuestions: EditableQuestion[] = []

  for (const question of questionRows) {
    let choices = choicesFor.get(question.id)
    if (!choices) choices = []

    let topicId = null
    const found = topicFor.get(question.id)
    if (found) topicId = found

    initialQuestions.push({
      id: question.id,
      pageId: question.pageId,
      ordinal: question.ordinal,
      printedNumber: question.printedNumber,
      promptText: question.promptText,
      questionType: question.questionType,
      bbox: question.bbox,
      correctAnswer: question.correctAnswer,
      choices,
      topicId,
    })
  }

  let overCount = 0
  if (worksheet.expectedQuestionCount) {
    overCount = initialQuestions.length - worksheet.expectedQuestionCount
  }

  let focusId = null
  if (focus) focusId = focus

  let heading = 'Add your questions'
  let intro =
    'Drag a box around each question on the page. The text fills in automatically from what we could read. Fix anything that came out wrong. Nothing counts toward your stats until you confirm.'

  if (initialQuestions.length > 0) {
    heading = 'Edit what we found'

    let noun = 'questions'
    if (initialQuestions.length === 1) noun = 'question'

    intro =
      'We pulled ' +
      initialQuestions.length +
      ' ' +
      noun +
      ' off the page automatically. Compare them against the original. Fix anything that came out wrong, and drag a box on the page if one was missed. Nothing counts toward your stats until you confirm.'
  }

  return (
    <main className="w-full px-4 py-8 sm:px-6">
      <nav aria-label="Breadcrumb" className="mb-4 text-sm">
        <Link
          href="/dashboard"
          className="text-muted hover:text-fg"
        >
          Dashboard
        </Link>
      </nav>

      <h1 className="text-balance text-2xl font-semibold tracking-tight">{heading}</h1>
      <p className="hint mb-6 text-pretty">{intro}</p>

      {overCount > 0 && (
        <p
          role="status"
          className="mb-6 rounded-xl border border-caution/50 px-3 py-2 text-sm text-pretty"
        >
          That is <span className="font-medium tabular-nums">{overCount} more</span>{' '}
          than the {worksheet.expectedQuestionCount} you said this paper has, so
          one was probably picked up twice or had its number misread. Deleting
          the wrong one would lose a real question, so nothing was removed.
          Worth checking for a duplicate before you confirm.
        </p>
      )}

      <EditClient
        worksheetId={id}
        worksheetTitle={worksheet.title}
        pages={pages}
        initialQuestions={initialQuestions}
        topics={await leafTopics()}
        focusId={focusId}
      />
    </main>
  )
}
