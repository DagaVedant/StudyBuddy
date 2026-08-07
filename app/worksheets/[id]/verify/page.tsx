import { and, asc, eq, inArray } from 'drizzle-orm'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { answerChoices, questions, worksheetPages, worksheets } from '@/lib/db/schema'
import { modalChoiceCount, validateQuestion, worthRereading } from '@/lib/questions/validate'

import { VerifyClient, type VerifiableQuestion } from './verify-client'

export const metadata = { title: 'Check Your Questions · StudyBuddy' }

type Params = { params: Promise<{ id: string }> }

export default async function VerifyPage({ params }: Params) {
  const session = await auth()
  if (!session?.user?.id) redirect('/signin')

  const { id } = await params

  const [worksheet] = await db
    .select({ id: worksheets.id, title: worksheets.title })
    .from(worksheets)
    .where(and(eq(worksheets.id, id), eq(worksheets.userId, session.user.id)))
    .limit(1)

  if (!worksheet) notFound()

  const rows = await db
    .select({
      id: questions.id,
      ordinal: questions.ordinal,
      printedNumber: questions.printedNumber,
      promptText: questions.promptText,
      questionType: questions.questionType,
      userVerified: questions.userVerified,
      pageNumber: worksheetPages.pageNumber,
    })
    .from(questions)
    .leftJoin(worksheetPages, eq(worksheetPages.id, questions.pageId))
    .where(eq(questions.worksheetId, id))
    .orderBy(asc(questions.ordinal))

  const choiceRows = rows.length
    ? await db
        .select({
          questionId: answerChoices.questionId,
          label: answerChoices.label,
          text: answerChoices.text,
        })
        .from(answerChoices)
        .where(
          inArray(
            answerChoices.questionId,
            rows.map((row) => row.id),
          ),
        )
    : []

  const choicesFor = new Map<string, { label: string; text: string }[]>()
  for (const choice of choiceRows) {
    choicesFor.set(choice.questionId, [
      ...(choicesFor.get(choice.questionId) ?? []),
      { label: choice.label, text: choice.text },
    ])
  }

  const shaped = rows.map((row) => ({
    ...row,
    choices: choicesFor.get(row.id) ?? [],
  }))

  // The paper decides what a complete answer list looks like, so the flags
  // below mean the same thing they do during extraction.
  const expectedChoiceCount = modalChoiceCount(shaped)

  const items: VerifiableQuestion[] = shaped.map((row) => {
    const flags = validateQuestion(row, { expectedChoiceCount })
    return {
      id: row.id,
      printedNumber: row.printedNumber,
      ordinal: row.ordinal,
      pageNumber: row.pageNumber,
      promptText: row.promptText,
      choices: row.choices,
      userVerified: row.userVerified,
      concerns: worthRereading(flags) ? flags.map((flag) => flag.detail) : [],
    }
  })

  // Doubtful questions first. Somebody who stops after twenty cards should
  // have spent those twenty on the ones most likely to be wrong, which
  // matters more than showing the paper in order.
  const ordered = [...items].sort((a, b) => {
    const doubtA = a.concerns.length > 0 ? 0 : 1
    const doubtB = b.concerns.length > 0 ? 0 : 1
    if (doubtA !== doubtB) return doubtA - doubtB
    return a.ordinal - b.ordinal
  })

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <h1 className="text-balance text-2xl font-semibold tracking-tight">
        Check Your Questions
      </h1>
      <p className="hint mb-6 text-pretty">
        {worksheet.title}. Compare each one against the page it came from and say
        whether we read it correctly.
      </p>

      <VerifyClient worksheetId={worksheet.id} questions={ordered} />
    </main>
  )
}
