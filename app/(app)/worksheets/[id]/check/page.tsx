import { and, eq } from 'drizzle-orm'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { getCredentialSummary } from '@/lib/ai/resolve'
import { isCloudProvider } from '@/lib/ai/providers'
import TopicSorter from '@/components/topic-sorter'
import { db } from '@/lib/db'
import { worksheetPages, worksheets } from '@/lib/db/schema'
import { evidenceFor } from '@/lib/questions/evidence'
import { findLibraryDuplicates } from '@/lib/questions/library-duplicates'
import { loadQuestionsWithChoices } from '@/lib/questions/load'
import { modalChoiceCount, validateQuestion, worthRereading } from '@/lib/questions/validate'

import { CheckClient, type CheckableQuestion } from './check-client'

export const metadata = { title: 'Check Your Questions · StudyBuddy' }

type Params = { params: Promise<{ id: string }> }

export default async function CheckPage({ params }: Params) {
  const session = await auth()
  if (!session?.user?.id) redirect('/signin')

  const { id } = await params

  const [worksheet] = await db
    .select({
      id: worksheets.id,
      title: worksheets.title,
      classificationError: worksheets.classificationError,
    })
    .from(worksheets)
    .where(and(eq(worksheets.id, id), eq(worksheets.userId, session.user.id)))
    .limit(1)

  if (!worksheet) notFound()

  const [shaped, duplicates, pageRows, credentials] = await Promise.all([
    loadQuestionsWithChoices(db, id),
    findLibraryDuplicates(db, session.user.id, id),
    db
      .select({
        id: worksheetPages.id,
        imageKey: worksheetPages.imageKey,
        width: worksheetPages.width,
        height: worksheetPages.height,
      })
      .from(worksheetPages)
      .where(eq(worksheetPages.worksheetId, id)),
    getCredentialSummary(db, session.user.id),
  ])

  const canSortHere = credentials.some((row) => isCloudProvider(row.provider))

  const duplicateFor = new Map(duplicates.map((row) => [row.questionId, row]))
  const pageFor = new Map(pageRows.map((page) => [page.id, page]))

  const expectedChoiceCount = modalChoiceCount(shaped)

  const items: CheckableQuestion[] = shaped.map((row) => {
    const flags = validateQuestion(row, { expectedChoiceCount })
    const duplicate = duplicateFor.get(row.id)

    return {
      id: row.id,
      printedNumber: row.printedNumber,
      ordinal: row.ordinal,
      pageNumber: row.pageNumber,
      promptText: row.promptText,
      choices: row.choices,
      userVerified: row.userVerified,
      concerns: worthRereading(flags) ? flags.map((flag) => flag.detail) : [],
      duplicateOf: duplicate
        ? {
            worksheetId: duplicate.matchWorksheetId,
            worksheetTitle: duplicate.matchWorksheetTitle,
            exact: duplicate.exact,
          }
        : null,
      evidence: evidenceFor(
        row.bbox,
        row.pageId ? pageFor.get(row.pageId) : undefined,
      ),
    }
  })

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

      {worksheet.classificationError && (
        <div className="mb-6 rounded-xl border border-caution/40 bg-caution/10 px-3 py-2 text-sm text-caution">
          <p role="alert">
            {worksheet.classificationError}{' '}
            {canSortHere
              ? 'Until they are sorted, your answers still count; they just will not show up by topic.'
              : 'Your answers still count once you mark this worksheet; they just will not show up sorted by topic.'}
          </p>

          {canSortHere && (
            <div className="mt-3">
              <TopicSorter
                worksheets={[{ id: worksheet.id, title: worksheet.title }]}
                label="Sort these into topics"
              />
            </div>
          )}
        </div>
      )}

      <CheckClient worksheetId={worksheet.id} questions={ordered} />
    </main>
  )
}
