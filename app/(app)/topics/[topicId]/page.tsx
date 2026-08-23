import {and, desc, eq, sql} from 'drizzle-orm'
import Link from 'next/link'
import {notFound, redirect} from 'next/navigation'

import {auth} from '@/auth'
import {AccuracyLabel, Meter} from '@/components/meter'
import {db} from '@/lib/db'
import {summarize} from '@/lib/ranking'
import {answerChoices, attempts, questionTopics, questions, topics, worksheets} from '@/lib/schema'
import {CHOICE_ORDER} from '@/lib/questions/queries'
import {pathBySlug} from '@/lib/taxonomy'
import {countGenerated, getLesson} from '@/lib/practice'
import {Prose} from '@/components/prose'
import {RevisitQuestion} from '@/components/revisit-question'
import {GenerateLessonButton} from '@/components/generate-lesson'
import {GeneratePracticeButton} from '@/components/generate-practice'

export const metadata = {title: 'Topic · StudyBuddy'}
export const dynamic = 'force-dynamic'

export default async function TopicPage({
  params,
}: {
  params: Promise<{topicId: string}>
}) {
  const {topicId} = await params

  const session = await auth()
  if (!session?.user?.id) redirect('/signin')
  const userId = session.user.id

  const [topic] = await db.select().from(topics).where(eq(topics.id, topicId)).limit(1)
  if (!topic) notFound()

  const path = pathBySlug().get(topic.slug) ?? topic.name
  const lesson = await getLesson(db, topicId, userId)
  const generated = await countGenerated(db, userId, topicId)

  const [tally] = await db
    .select({
      correct: sql<number>`count(*) filter (where ${attempts.outcome} = 'correct')::int`,
      unsure: sql<number>`count(*) filter (where ${attempts.outcome} = 'unsure')::int`,
      wrong: sql<number>`count(*) filter (where ${attempts.outcome} = 'wrong')::int`,
    })
    .from(attempts)
    .innerJoin(questionTopics, eq(questionTopics.questionId, attempts.questionId))
    .innerJoin(questions, eq(questions.id, attempts.questionId))
    .where(
      and(
        eq(attempts.userId, userId),
        eq(questionTopics.topicId, topicId),
        eq(questions.origin, 'extracted'),
      ),
    )

  const stats = summarize({
    topicId,
    topicName: topic.name,
    topicPath: path,
    subjectRoot: topic.subjectRoot,
    trend: null,
    correct: tally.correct,
    unsure: tally.unsure,
    wrong: tally.wrong,
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

      <h1 className="text-balance text-2xl font-semibold tracking-tight">
        {topic.name}
      </h1>
      <p className="hint mb-6 text-pretty">{path}</p>

      <section aria-labelledby="mastery-heading">
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
          <div>
            <dt className="text-muted">Got it</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums">{stats.correct}</dd>
          </div>
          <div>
            <dt className="text-muted">Unsure</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums">{stats.unsure}</dd>
          </div>
          <div>
            <dt className="text-muted">Missed</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums">{stats.wrong}</dd>
          </div>
        </dl>

        {!stats.ranked && (
          <p className="hint text-pretty">
            Not enough answers here yet to call this a strength or a weakness.
          </p>
        )}
      </section>

      {!lesson && (
        <section aria-labelledby="lesson-heading" className="mt-6">
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
        <section aria-labelledby="lesson-heading" className="mt-6">
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
                  <li key={index} className="rounded-xl p-3">
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

          <p className="hint mt-6 text-pretty">
            Written by {lesson.model ?? 'a model'}, not by a teacher. Each question
            below says which paper it came from.
          </p>
        </section>
      )}

      <section aria-labelledby="practice-heading" className="mt-6">
        <h2 id="practice-heading" className="text-sm font-medium">
          Practice questions
        </h2>
        <p className="hint mt-1 text-pretty">
          {generated === 0
            ? 'Every question above came off a paper you uploaded. This writes new ones on the same topic so there is something to practise on once you have worked through your own.'
            : `${generated} written for you so far. They sit in your review queue alongside the questions you missed, and they are kept out of your accuracy, because a model wrote the answer key.`}
        </p>
        <div className="mt-3">
          <GeneratePracticeButton topicId={topicId} />
        </div>
      </section>

      <section aria-labelledby="vault-heading" className="mt-6">
        <h2 id="vault-heading" className="text-sm font-medium">
          Questions to revisit
        </h2>
        <p className="hint mb-3 text-pretty">
          Everything in this topic you missed or guessed, newest first.
        </p>

        {vault.length === 0 ? (
          <p className="rounded-2xl card-sunk px-3 py-8 text-center text-sm text-muted">
            Nothing to revisit here. You have not missed a question in this topic.
          </p>
        ) : (
          <ul className="divide-y divide-fg/20">
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
          <Link
            href={`/review?topic=${topicId}`}
            className="btn btn-primary sm:w-auto sm:px-6"
          >
            Review these now
          </Link>
        </div>
      </section>
    </main>
  )
}
