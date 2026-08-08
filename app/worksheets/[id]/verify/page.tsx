import { and, eq } from 'drizzle-orm'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { worksheets } from '@/lib/db/schema'
import { loadQuestionsWithChoices } from '@/lib/questions/load'
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

  const shaped = await loadQuestionsWithChoices(db, id)

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

  // Paper order, so card one is question one. Doubtful questions used to come
  // first, on the theory that a student who stops early should spend their
  // cards where the reading is most likely wrong. In practice opening on
  // question 25 reads as a bug: there is nothing to compare against yet, so
  // the jump looks like the wrong worksheet rather than like triage. The
  // concern banner still marks the doubtful ones as they come round.
  const ordered = items

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
