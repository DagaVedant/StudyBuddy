import {NextResponse} from 'next/server'
import {asc, eq} from 'drizzle-orm'
import {authenticateWorker} from '@/lib/worker/jobs'
import {worksheetPages} from '@/lib/schema'
import {db} from '@/lib/db'
import {loadQuestionsWithChoices} from '@/lib/questions/queries'

export async function GET(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const auth = authenticateWorker(request)
  if (!auth.ok) {
    return NextResponse.json({error: auth.message}, {status: auth.status})
  }

  const {worksheetId} = await params

  const pages = await db
    .select({id: worksheetPages.id, pageNumber: worksheetPages.pageNumber})
    .from(worksheetPages)
    .where(eq(worksheetPages.worksheetId, worksheetId))
    .orderBy(asc(worksheetPages.pageNumber))

  const rows = await loadQuestionsWithChoices(db, worksheetId)
  const pageNumberFor = new Map(pages.map((page) => [page.id, page.pageNumber]))

  const payload = []
  for (const row of rows) {
    const pageNumber = row.pageId ? pageNumberFor.get(row.pageId) : undefined
    if (pageNumber === undefined) continue

    payload.push({
      id: row.id,
      pageNumber,
      printedNumber: row.printedNumber,
      promptText: row.promptText,
      questionType: row.questionType,
      choices: row.choices.map((choice) => ({label: choice.label, text: choice.text})),
    })
  }

  return NextResponse.json({questions: payload})
}
