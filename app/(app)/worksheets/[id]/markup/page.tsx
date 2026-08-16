import { and, asc, eq } from 'drizzle-orm'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { CHOICE_ORDER } from '@/lib/questions/choice-order'
import { answerChoices, attempts, questions, worksheets } from '@/lib/db/schema'

import CorrectionsClient, { type MarkedQuestion } from './corrections-client'
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

  // Marking a worksheet is a one-time thing: you sat the paper once, so there
  // is one set of outcomes to record. Coming back here (from a bookmark, the
  // back button, a stale tab) used to offer the whole flow again and write a
  // second attempt per question, which moves the review schedule on answers
  // the student never actually gave. Every link into this page is dropped once
  // the marks exist; this is the guard behind them.
  const marks = await db
    .select({
      questionId: attempts.questionId,
      outcome: attempts.outcome,
      selectedChoiceId: attempts.selectedChoiceId,
    })
    .from(attempts)
    .innerJoin(questions, eq(questions.id, attempts.questionId))
    .where(
      and(
        eq(questions.worksheetId, id),
        eq(attempts.userId, session.user.id),
        eq(attempts.source, 'markup'),
      ),
    )

  /*
   * Marked already, so this shows what was recorded and lets one row be
   * changed. It used to be a dead end reading "that is all it needs".
   *
   * The guard above is still doing its job: what is refused is re-running the
   * flow, not correcting a row. A student flying through forty questions at one
   * tap each will occasionally tap the wrong one, and that tap fed the FSRS
   * schedule, the topic accuracy, the weakness ranking and the Blooket export
   * with no way back. A question mis-marked `correct` left the practice queue
   * permanently, and the only recourse was deleting the worksheet and uploading
   * it again, at the cost of a trial credit.
   */
  if (marks.length > 0) {
    const markByQuestion = new Map(marks.map((mark) => [mark.questionId, mark]))

    const markedRows = await db
      .select({
        id: questions.id,
        ordinal: questions.ordinal,
        promptText: questions.promptText,
      })
      .from(questions)
      .where(eq(questions.worksheetId, id))
      .orderBy(asc(questions.ordinal))

    const markedChoices = await db
      .select({
        id: answerChoices.id,
        questionId: answerChoices.questionId,
        label: answerChoices.label,
        text: answerChoices.text,
      })
      .from(answerChoices)
      .innerJoin(questions, eq(answerChoices.questionId, questions.id))
      .where(eq(questions.worksheetId, id))
      .orderBy(...CHOICE_ORDER)

    const corrections: MarkedQuestion[] = markedRows
      .filter((question) => markByQuestion.has(question.id))
      .map((question) => {
        const mark = markByQuestion.get(question.id)!

        return {
          id: question.id,
          ordinal: question.ordinal,
          promptText: question.promptText,
          outcome: mark.outcome as MarkedQuestion['outcome'],
          selectedChoiceId: mark.selectedChoiceId,
          choices: markedChoices
            .filter((choice) => choice.questionId === question.id)
            .map(({ id: choiceId, label, text }) => ({ id: choiceId, label, text })),
        }
      })

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
          What You Recorded
        </h1>
        <p className="hint mb-8 text-pretty">
          {worksheet.title}. The ones you missed are in your practice queue. If a
          tap went astray, change it here: each question saves on its own.
        </p>

        <CorrectionsClient worksheetId={id} questions={corrections} />

        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link href="/review" className="btn btn-primary sm:w-auto sm:px-6">
            Practice
          </Link>
          <Link href="/dashboard" className="btn btn-secondary sm:w-auto sm:px-6">
            Dashboard
          </Link>
        </div>
      </main>
    )
  }

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
    .orderBy(...CHOICE_ORDER)

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
