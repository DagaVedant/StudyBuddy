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
  type BBox,
  type TextLine,
} from '@/lib/db/schema'
import { pathBySlug } from '@/lib/taxonomy/trees'

import ReviewClient, { type EditablePage, type EditableQuestion } from './review-client'

export const metadata = { title: 'Review Questions · StudyBuddy' }

async function leafTopics(): Promise<TopicChoice[]> {
  const paths = pathBySlug()

  const rows = await db
    .select({ id: topics.id, slug: topics.slug, name: topics.name })
    .from(topics)
    .where(eq(topics.isLeaf, true))

  return rows
    .map((row) => ({ ...row, path: paths.get(row.slug) ?? row.name }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * A page's words, at the precision they are actually compared at.
 *
 * pdf.js hands back transformed floats, so a line's box serializes as
 * `[56.79999999999995, 712.3200000000002, …]`: four numbers of eighteen
 * characters, on up to 4000 lines a page, all of it crossing the wire in the
 * RSC payload. `textInside` only asks which side of a dragged box the centre of
 * a line falls on, in whole page pixels, and the drag it compares against comes
 * from a fingertip. Everything past the decimal point is payload and nothing
 * else.
 */
function roundLines(lines: TextLine[] | null): TextLine[] {
  return (lines ?? []).map((line) => {
    const bbox: BBox = [
      Math.round(line.bbox[0]),
      Math.round(line.bbox[1]),
      Math.round(line.bbox[2]),
      Math.round(line.bbox[3]),
    ]
    return { text: line.text, bbox }
  })
}

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const session = await auth()
  if (!session?.user?.id) redirect('/signin')

  // Projected, here and in the two queries below. `select()` reads every column
  // the table has, and two of these three tables carry a column this file never
  // looks at and would rather not have fetched: a page row holds `ocrText`, the
  // whole page as one string and capped at 200 KB, and a question row holds a
  // 384 dimension embedding. On a twenty page paper that was several megabytes
  // read out of Postgres and dropped on the floor, on every render of this
  // screen.
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
      // Carried through to the client as the key for the choice's row. See the
      // note on `choices` in types.ts.
      id: answerChoices.id,
      label: answerChoices.label,
      text: answerChoices.text,
      isCorrect: answerChoices.isCorrect,
    })
    .from(answerChoices)
    .innerJoin(questions, eq(answerChoices.questionId, questions.id))
    .where(eq(questions.worksheetId, id))
    // Ordered, because everything downstream treats position as label order:
    // the relabel on remove is `.map((other, i) => CHOICE_LABELS[i])` and Add
    // Choice takes `CHOICE_LABELS[choices.length]`. Postgres is free to return
    // a question's rows in any order it likes, and the PATCH route deletes and
    // reinserts every choice with whatever labels it was handed, so one
    // reordered read would write the scramble back permanently.
    .orderBy(asc(answerChoices.label), asc(answerChoices.id))

  const topicRows = await db
    .select({
      questionId: questionTopics.questionId,
      topicId: questionTopics.topicId,
    })
    .from(questionTopics)
    .innerJoin(questions, eq(questionTopics.questionId, questions.id))
    .where(eq(questions.worksheetId, id))

  // Every page's lines go down, not just the ones on the page showing. Paging
  // is client state with no round trip behind it, and the drag that adds a
  // missed question reads the lines under the box on whichever page that is, so
  // cutting the other pages' lines would leave the drag silently reading
  // nothing on page two onwards. `roundLines` is what pays for carrying them.
  const pages: EditablePage[] = pageRows.map((page) => ({
    id: page.id,
    pageNumber: page.pageNumber,
    imageSrc: `/api/files/${page.imageKey}`,
    width: page.width ?? 1000,
    height: page.height ?? 1400,
    textLines: roundLines(page.textLines),
  }))

  // Grouped once. Scanning both flat lists per question was two linear passes
  // over every choice and every topic row for each of 114 questions.
  const choicesFor = new Map<string, EditableQuestion['choices']>()
  for (const { questionId, id: choiceId, label, text, isCorrect } of choiceRows) {
    const choice = { id: choiceId, label, text, isCorrect }
    const list = choicesFor.get(questionId)
    if (list) list.push(choice)
    else choicesFor.set(questionId, [choice])
  }

  const topicFor = new Map<string, string>()
  for (const row of topicRows) {
    if (!topicFor.has(row.questionId)) topicFor.set(row.questionId, row.topicId)
  }

  const initialQuestions: EditableQuestion[] = questionRows.map((question) => ({
    id: question.id,
    pageId: question.pageId,
    ordinal: question.ordinal,
    printedNumber: question.printedNumber,
    promptText: question.promptText,
    questionType: question.questionType,
    bbox: question.bbox,
    correctAnswer: question.correctAnswer,
    choices: choicesFor.get(question.id) ?? [],
    topicId: topicFor.get(question.id) ?? null,
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
