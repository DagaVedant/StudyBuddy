import { and, eq } from 'drizzle-orm'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { worksheetPages, worksheets } from '@/lib/db/schema'
import type { BBox } from '@/lib/db/schema'
import { findLibraryDuplicates } from '@/lib/questions/library-duplicates'
import { loadQuestionsWithChoices } from '@/lib/questions/load'
import { modalChoiceCount, validateQuestion, worthRereading } from '@/lib/questions/validate'

import {
  VerifyClient,
  type QuestionEvidence,
  type VerifiableQuestion,
} from './verify-client'

export const metadata = { title: 'Check Your Questions · StudyBuddy' }

type Params = { params: Promise<{ id: string }> }

type PageImage = {
  imageKey: string
  width: number | null
  height: number | null
}

/**
 * The scan a question can be checked against, or null if none can be placed.
 *
 * The bbox is in the page image's own pixels, so a page that never recorded
 * its size gives nothing to measure it against and the crop would land
 * somewhere arbitrary. A box with no area, or one that falls off the page
 * entirely, is the reader guessing; both come back from extraction and neither
 * can be cropped to. Every one of these degrades to no image, because a crop
 * of the wrong part of the page is worse than none on a screen whose whole
 * job is comparing against the paper.
 */
function evidenceFor(
  bbox: BBox | null,
  page: PageImage | undefined,
): QuestionEvidence | null {
  if (!bbox || !page?.width || !page.height) return null

  const [x0, y0, x1, y1] = bbox
  if (x1 <= x0 || y1 <= y0) return null
  if (x0 >= page.width || y0 >= page.height || x1 <= 0 || y1 <= 0) return null

  return {
    src: `/api/files/${page.imageKey}`,
    width: page.width,
    height: page.height,
    bbox,
  }
}

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

  const [shaped, duplicates, pageRows] = await Promise.all([
    loadQuestionsWithChoices(db, id),
    findLibraryDuplicates(db, session.user.id, id),
    // The scans themselves. `loadQuestionsWithChoices` carries the page number
    // but not the image, and this screen asks the student to compare each
    // question against the page it came from, which it could not show.
    db
      .select({
        id: worksheetPages.id,
        imageKey: worksheetPages.imageKey,
        width: worksheetPages.width,
        height: worksheetPages.height,
      })
      .from(worksheetPages)
      .where(eq(worksheetPages.worksheetId, id)),
  ])

  const duplicateFor = new Map(duplicates.map((row) => [row.questionId, row]))
  const pageFor = new Map(pageRows.map((page) => [page.id, page]))

  // The paper decides what a complete answer list looks like, so the flags
  // below mean the same thing they do during extraction.
  const expectedChoiceCount = modalChoiceCount(shaped)

  const items: VerifiableQuestion[] = shaped.map((row) => {
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
