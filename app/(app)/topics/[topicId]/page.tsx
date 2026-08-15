import { and, desc, eq, sql } from 'drizzle-orm'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ViewTransition } from 'react'

import { auth } from '@/auth'
import { AccuracyLabel, Meter } from '@/components/meter'
import { db } from '@/lib/db'
import { summarize } from '@/lib/dashboard/ranking'
import {
  answerChoices,
  attempts,
  questionTopics,
  questions,
  topics,
  worksheets,
} from '@/lib/db/schema'
import { CHOICE_ORDER } from '@/lib/questions/choice-order'
import { pathBySlug } from '@/lib/taxonomy/trees'
import { getLesson } from '@/lib/topics/lesson'
import Prose from '@/components/prose'
import RevisitQuestion from '@/components/revisit-question'
import GenerateLessonButton from '@/components/generate-lesson-button'

export const metadata = { title: 'Topic · StudyBuddy' }
export const dynamic = 'force-dynamic'

export default async function TopicPage({
  params,
}: {
  params: Promise<{ topicId: string }>
}) {
  const { topicId } = await params

  const session = await auth()
  if (!session?.user?.id) redirect('/signin')
  const userId = session.user.id

  const [topic] = await db.select().from(topics).where(eq(topics.id, topicId)).limit(1)
  if (!topic) notFound()

  const path = pathBySlug().get(topic.slug) ?? topic.name
  const lesson = await getLesson(db, topicId)

  const [tally] = await db
    .select({
      correct: sql<number>`count(*) filter (where ${attempts.outcome} = 'correct')::int`,
      unsure: sql<number>`count(*) filter (where ${attempts.outcome} = 'unsure')::int`,
      wrong: sql<number>`count(*) filter (where ${attempts.outcome} = 'wrong')::int`,
    })
    .from(attempts)
    .innerJoin(questionTopics, eq(questionTopics.questionId, attempts.questionId))
    .where(and(eq(attempts.userId, userId), eq(questionTopics.topicId, topicId)))

  const stats = summarize({
    topicId,
    topicName: topic.name,
    topicPath: path,
    subjectRoot: topic.subjectRoot,
    correct: Number(tally?.correct ?? 0),
    unsure: Number(tally?.unsure ?? 0),
    wrong: Number(tally?.wrong ?? 0),
  })

  const vault = await db
    .select({
      questionId: questions.id,
      promptText: questions.promptText,
      outcome: attempts.outcome,
      answeredAt: attempts.createdAt,
      selectedChoiceId: attempts.selectedChoiceId,
      freeText: attempts.freeTextAnswer,
      worksheetTitle: worksheets.title,
    })
    .from(attempts)
    .innerJoin(questions, eq(questions.id, attempts.questionId))
    .innerJoin(questionTopics, eq(questionTopics.questionId, questions.id))
    .innerJoin(worksheets, eq(worksheets.id, questions.worksheetId))
    .where(
      and(
        eq(attempts.userId, userId),
        eq(questionTopics.topicId, topicId),
        sql`${attempts.outcome} in ('wrong','unsure')`,
      ),
    )
    .orderBy(desc(attempts.createdAt))
    .limit(50)

  const choiceRows = vault.some((row) => row.selectedChoiceId)
    ? await db
        .select({
          id: answerChoices.id,
          label: answerChoices.label,
          text: answerChoices.text,
          isCorrect: answerChoices.isCorrect,
          questionId: answerChoices.questionId,
        })
        .from(answerChoices)
        .innerJoin(questions, eq(questions.id, answerChoices.questionId))
        .innerJoin(questionTopics, eq(questionTopics.questionId, questions.id))
        .where(eq(questionTopics.topicId, topicId))
        .orderBy(...CHOICE_ORDER)
    : []

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <nav aria-label="Breadcrumb" className="mb-4 text-sm">
        <Link
          href="/dashboard"
          className="text-muted underline underline-offset-2 hover:text-fg"
        >
          Dashboard
        </Link>
      </nav>

      {/* Pairs with the weakest-topics row on the dashboard. */}
      <ViewTransition
        name={`topic-title-${topicId}`}
        share="topic-title"
        default="none"
      >
        <h1 className="text-balance text-2xl font-semibold tracking-tight">
          {topic.name}
        </h1>
      </ViewTransition>
      <p className="hint mb-6 text-pretty">{path}</p>

      <section
        aria-labelledby="mastery-heading"
        className="card p-4"
      >
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="mastery-heading" className="text-sm font-medium">
            Accuracy
          </h2>
          <AccuracyLabel
            accuracy={stats.accuracy}
            ranked={stats.ranked}
            attempts={stats.attempts}
          />
        </div>

        <div className="mt-3">
          <Meter accuracy={stats.accuracy} ranked={stats.ranked} label={topic.name} />
        </div>

        <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
          {[
            { label: 'Got it', value: stats.correct },
            { label: 'Unsure', value: stats.unsure },
            { label: 'Missed', value: stats.wrong },
          ].map((item) => (
            <div key={item.label}>
              <dt className="text-muted">{item.label}</dt>
              <dd className="mt-0.5 text-lg font-semibold tabular-nums">{item.value}</dd>
            </div>
          ))}
        </dl>

        {!stats.ranked && (
          <p className="hint text-pretty">
            Not enough answers here yet to call this a strength or a weakness.
          </p>
        )}
      </section>

      {!lesson && (
        <section aria-labelledby="lesson-heading" className="card mt-6 p-4">
          <h2 id="lesson-heading" className="text-sm font-medium">
            How this works
          </h2>
          <p className="hint mt-1 text-pretty">
            Nobody has written an explanation for this topic yet.
          </p>
          <div className="mt-3">
            <GenerateLessonButton topicId={topicId} />
          </div>
        </section>
      )}

      {lesson && (
        <section aria-labelledby="lesson-heading" className="card mt-6 p-4">
          <h2 id="lesson-heading" className="text-sm font-medium">
            How this works
          </h2>

          <div className="mt-3">
            <Prose markdown={lesson.bodyMd} />
          </div>

          {lesson.examples.length > 0 && (
            <>
              <h3 className="mt-6 text-sm font-semibold tracking-tight">Worked examples</h3>
              <ol className="mt-2 space-y-4">
                {lesson.examples.map((example, index) => (
                  <li key={index} className="rounded-xl border border-border p-3">
                    <p className="text-pretty text-sm font-medium">{example.question}</p>
                    <div className="mt-2">
                      <Prose markdown={example.working} />
                    </div>
                    <p className="mt-2 text-sm">
                      <span className="text-muted">Answer: </span>
                      <span className="font-semibold">{example.answer}</span>
                    </p>
                  </li>
                ))}
              </ol>
            </>
          )}

          {lesson.commonErrors.length > 0 && (
            <>
              <h3 className="mt-6 text-sm font-semibold tracking-tight">
                Where people go wrong
              </h3>
              <ul className="mt-2 space-y-3">
                {lesson.commonErrors.map((error, index) => (
                  <li key={index}>
                    <p className="text-pretty text-sm font-medium">{error.mistake}</p>
                    <p className="hint text-pretty">{error.why}</p>
                    <p className="mt-0.5 text-pretty text-sm">
                      <span className="text-muted">Instead: </span>
                      {error.fix}
                    </p>
                  </li>
                ))}
              </ul>
            </>
          )}

          {/*
            Said plainly rather than left for the reader to assume. This is
            teaching material a model wrote, not something a teacher checked,
            and the questions below it are the student's own real work. Telling
            the two apart matters more here than anywhere else on the site.
          */}
          <p className="hint mt-6 text-pretty">
            Written by {lesson.model ?? 'a model'}, not by a teacher. The questions
            below are your own.
          </p>
        </section>
      )}

      <section aria-labelledby="vault-heading" className="mt-6">
        <h2 id="vault-heading" className="text-sm font-medium">
          Questions to revisit
        </h2>
        <p className="hint mb-3 text-pretty">
          Everything in this topic you missed or guessed, newest first.
        </p>

        {vault.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border px-3 py-8 text-center text-sm text-muted">
            Nothing to revisit here. You have not missed a question in this topic.
          </p>
        ) : (
          <ul className="space-y-2">
            {vault.map((row, index) => {
              const chosen = choiceRows.find((c) => c.id === row.selectedChoiceId)
              const correct = choiceRows.find(
                (c) => c.questionId === row.questionId && c.isCorrect,
              )

              return (
                <RevisitQuestion
                  key={`${row.questionId}-${index}`}
                  promptText={row.promptText}
                  outcome={row.outcome}
                  answeredAt={row.answeredAt}
                  worksheetTitle={row.worksheetTitle}
                  chosen={chosen}
                  correct={correct}
                  freeText={row.freeText}
                />
              )
            })}
          </ul>
        )}

        <div className="mt-4">
          <Link href="/review" className="btn btn-primary sm:w-auto sm:px-6">
            Review these now
          </Link>
        </div>
      </section>
    </main>
  )
}
