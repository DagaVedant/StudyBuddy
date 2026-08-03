import { asc, eq } from 'drizzle-orm'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import type { TopicChoice } from '@/components/topic-picker'
import { db } from '@/lib/db'
import {
  answerChoices,
  questionTopics,
  questions,
  topics,
  worksheetPages,
  worksheets,
} from '@/lib/db/schema'
import { flattenTaxonomy } from '@/lib/taxonomy/trees'

import ReviewClient, { type EditablePage, type EditableQuestion } from './review-client'

export const metadata = { title: 'Review Questions · StudyBuddy' }

async function leafTopics(): Promise<TopicChoice[]> {
  const pathBySlug = new Map(flattenTaxonomy().map((topic) => [topic.slug, topic.path]))

  const rows = await db
    .select({ id: topics.id, slug: topics.slug, name: topics.name })
    .from(topics)
    .where(eq(topics.isLeaf, true))

  return rows
    .map((row) => ({ ...row, path: pathBySlug.get(row.slug) ?? row.name }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const session = await auth()
  if (!session?.user?.id) redirect('/signin')

  const [worksheet] = await db
    .select()
    .from(worksheets)
    .where(eq(worksheets.id, id))
    .limit(1)

  if (!worksheet || worksheet.userId !== session.user.id) notFound()

  const pageRows = await db
    .select()
    .from(worksheetPages)
    .where(eq(worksheetPages.worksheetId, id))
    .orderBy(asc(worksheetPages.pageNumber))

  const questionRows = await db
    .select()
    .from(questions)
    .where(eq(questions.worksheetId, id))
    .orderBy(asc(questions.ordinal))

  const choiceRows = await db
    .select({
      questionId: answerChoices.questionId,
      label: answerChoices.label,
      text: answerChoices.text,
      isCorrect: answerChoices.isCorrect,
    })
    .from(answerChoices)
    .innerJoin(questions, eq(answerChoices.questionId, questions.id))
    .where(eq(questions.worksheetId, id))

  const topicRows = await db
    .select({
      questionId: questionTopics.questionId,
      topicId: questionTopics.topicId,
    })
    .from(questionTopics)
    .innerJoin(questions, eq(questionTopics.questionId, questions.id))
    .where(eq(questions.worksheetId, id))

  const pages: EditablePage[] = pageRows.map((page) => ({
    id: page.id,
    pageNumber: page.pageNumber,
    imageSrc: `/api/files/${page.imageKey}`,
    width: page.width ?? 1000,
    height: page.height ?? 1400,
    textLines: page.textLines ?? [],
  }))

  const initialQuestions: EditableQuestion[] = questionRows.map((question) => ({
    id: question.id,
    pageId: question.pageId,
    ordinal: question.ordinal,
    promptText: question.promptText,
    questionType: question.questionType,
    bbox: question.bbox,
    correctAnswer: question.correctAnswer,
    choices: choiceRows
      .filter((choice) => choice.questionId === question.id)
      .map(({ label, text, isCorrect }) => ({ label, text, isCorrect })),
    topicId:
      topicRows.find((row) => row.questionId === question.id)?.topicId ?? null,
  }))

  const overCount = worksheet.expectedQuestionCount
    ? initialQuestions.length - worksheet.expectedQuestionCount
    : 0

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6">
      <nav aria-label="Breadcrumb" className="mb-4 text-sm">
        <Link
          href="/dashboard"
          className="text-muted underline underline-offset-2 hover:text-fg"
        >
          Dashboard
        </Link>
      </nav>

      <h1 className="text-balance text-2xl font-semibold tracking-tight">
        {initialQuestions.length > 0 ? 'Check What We Found' : 'Add Your Questions'}
      </h1>
      <p className="hint mb-6 text-pretty">
        {initialQuestions.length > 0
          ? `We pulled ${initialQuestions.length} ${initialQuestions.length === 1 ? 'question' : 'questions'} off the page automatically. Compare them against the original. Fix anything that came out wrong, and drag a box on the page if one was missed. Nothing counts toward your stats until you confirm.`
          : 'Drag a box around each question on the page. The text fills in automatically from what we could read. Fix anything that came out wrong. Nothing counts toward your stats until you confirm.'}
      </p>

      {overCount > 0 && (
        <p
          role="status"
          className="mb-6 rounded-xl border border-caution/50 px-3 py-2 text-sm text-pretty"
        >
          That is{' '}
          <span className="font-medium tabular-nums">
            {overCount} more
          </span>{' '}
          than the {worksheet.expectedQuestionCount} you said this paper has, so
          one was probably picked up twice or had its number misread. Deleting
          the wrong one would lose a real question, so nothing was removed.
          Worth checking for a duplicate before you confirm.
        </p>
      )}

      <ReviewClient
        worksheetId={id}
        worksheetTitle={worksheet.title}
        pages={pages}
        initialQuestions={initialQuestions}
        topics={await leafTopics()}
      />
    </main>
  )
}
