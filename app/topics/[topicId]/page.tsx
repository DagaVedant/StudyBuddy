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
import { flattenTaxonomy } from '@/lib/taxonomy/trees'

export const metadata = { title: 'Topic · StudyBuddy' }
export const dynamic = 'force-dynamic'

const WHEN = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

const OUTCOME_STYLE: Record<string, string> = {
  wrong: 'border-danger text-danger',
  unsure: 'border-caution text-caution',
  correct: 'border-success text-success',
}

const OUTCOME_LABEL: Record<string, string> = {
  wrong: 'Missed',
  unsure: 'Unsure',
  correct: 'Got it',
}

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

  const path = flattenTaxonomy().find((node) => node.slug === topic.slug)?.path ?? topic.name

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
                <li
                  key={`${row.questionId}-${index}`}
                  className="card p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 flex-1 whitespace-pre-line text-sm">
                      {row.promptText}
                    </p>
                    <span
                      className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${
                        OUTCOME_STYLE[row.outcome] ?? 'border-border text-muted'
                      }`}
                    >
                      {OUTCOME_LABEL[row.outcome] ?? row.outcome}
                    </span>
                  </div>

                  {(chosen || row.freeText) && (
                    <p className="mt-2 text-xs text-muted">
                      You put{' '}
                      <span className="text-danger">
                        {chosen ? `${chosen.label}. ${chosen.text}` : row.freeText}
                      </span>
                      {correct && (
                        <>
                          {' · answer '}
                          <span className="text-success">
                            {correct.label}. {correct.text}
                          </span>
                        </>
                      )}
                    </p>
                  )}

                  <p className="mt-1 text-xs text-muted">
                    {row.worksheetTitle} · {WHEN.format(row.answeredAt)}
                  </p>
                </li>
              )
            })}
          </ul>
        )}

        <div className="mt-4">
          <Link href="/review" className="btn btn-primary sm:w-auto sm:px-6">
            Review These Now
          </Link>
        </div>
      </section>
    </main>
  )
}
