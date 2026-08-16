import { asc, eq } from 'drizzle-orm'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { auth } from '@/auth'
import type { TopicChoice } from '@/components/topic-picker'
import { db } from '@/lib/db'
import { CHOICE_ORDER } from '@/lib/questions/sql'
import { roundLines } from '@/lib/questions/text-lines'
import {
  answerChoices,
  questionTopics,
  questions,
  topics,
  worksheetPages,
  worksheets,
} from '@/lib/db/schema'
import { pathBySlug } from '@/lib/taxonomy/trees'

import EditClient, { type EditablePage, type EditableQuestion } from './edit-client'

/*
 * "Edit", not "Review". Three screens used to share two words: this one and
 * /worksheets/[id]/verify were both about the extraction, and /review is the
 * spaced-repetition queue the nav teaches. So the nav said Review, the
 * worksheet card said "Check questions", and an upload landed on a URL ending
 * /review that was not the Review in the nav.
 *
 * "Review" now means practice and nothing else. This screen edits what came off
 * the page, and the one next door checks it, which is what each was already
 * called in its own heading.
 */
export const metadata = { title: 'Edit Questions · StudyBuddy' }

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

export default async function EditPage({
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
    .orderBy(...CHOICE_ORDER)

  const topicRows = await db
    .select({
      questionId: questionTopics.questionId,
      topicId: questionTopics.topicId,
    })
    .from(questionTopics)
    .innerJoin(questions, eq(questionTopics.questionId, questions.id))
    .where(eq(questions.worksheetId, id))

  // Only the page that opens first carries its lines down; the rest fetch
  // theirs from /api/worksheets/[id]/pages/[pageId]/lines when the reader
  // actually turns to them (EditClient). Paging used to be client state
  // with no round trip behind it specifically so the drag that adds a missed
  // question would always find lines under the box wherever the reader was,
  // which is why every page's lines went down regardless of which one was
  // showing - on a 75-page upload with up to 4000 lines a page, all of it,
  // every time this screen rendered. The drag now waits on its own page's
  // fetch (PageCanvas's `linesReady`) rather than assuming the lines already
  // arrived, so it can afford to ask for them only when they are needed.
  const pages: EditablePage[] = pageRows.map((page, index) => ({
    id: page.id,
    pageNumber: page.pageNumber,
    imageSrc: `/api/files/${page.imageKey}`,
    width: page.width ?? 1000,
    height: page.height ?? 1400,
    textLines: index === 0 ? roundLines(page.textLines) : [],
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
        {initialQuestions.length > 0 ? 'Edit What We Found' : 'Add Your Questions'}
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

      <EditClient
        worksheetId={id}
        worksheetTitle={worksheet.title}
        pages={pages}
        initialQuestions={initialQuestions}
        topics={await leafTopics()}
      />
    </main>
  )
}
