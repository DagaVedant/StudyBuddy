import { asc, eq } from 'drizzle-orm'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { answerChoices, questions, worksheets } from '@/lib/db/schema'

import MarkupClient, { type MarkableQuestion } from './markup-client'

export const metadata = { title: 'Mark Your Answers · StudyBuddy' }

export default async function MarkupPage({
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

  const questionRows = await db
    .select({
      id: questions.id,
      ordinal: questions.ordinal,
      promptText: questions.promptText,
      questionType: questions.questionType,
      correctAnswer: questions.correctAnswer,
    })
    .from(questions)
    .where(eq(questions.worksheetId, id))
    .orderBy(asc(questions.ordinal))

  const choiceRows = await db
    .select({
      id: answerChoices.id,
      questionId: answerChoices.questionId,
      label: answerChoices.label,
      text: answerChoices.text,
    })
    .from(answerChoices)
    .innerJoin(questions, eq(answerChoices.questionId, questions.id))
    .where(eq(questions.worksheetId, id))

  const markable: MarkableQuestion[] = questionRows.map((question) => ({
    ...question,
    choices: choiceRows
      .filter((choice) => choice.questionId === question.id)
      .map(({ id: choiceId, label, text }) => ({ id: choiceId, label, text })),
  }))

  if (markable.length === 0) {
    return (
      <main className="mx-auto w-full max-w-2xl px-6 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Nothing to Mark</h1>
        <p className="hint">
          This worksheet has no questions yet.{' '}
          <Link
            href={`/worksheets/${id}/review`}
            className="text-accent underline underline-offset-2"
          >
            Add some first
          </Link>
          .
        </p>
      </main>
    )
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-10">
      <nav aria-label="Breadcrumb" className="mb-4 text-sm">
        <Link
          href="/dashboard"
          className="text-muted underline underline-offset-2 hover:text-fg"
        >
          Dashboard
        </Link>
      </nav>

      <h1 className="text-balance text-2xl font-semibold tracking-tight">
        How Did You Do?
      </h1>
      <p className="hint mb-8 text-pretty">
        {worksheet.title}. Mark each question, then tell us what you put for the
        ones you missed.
      </p>

      <MarkupClient worksheetId={id} questions={markable} />
    </main>
  )
}
