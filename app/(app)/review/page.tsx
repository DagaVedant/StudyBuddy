import { eq } from 'drizzle-orm'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import PageHead from '@/components/page-head'

import { auth } from '@/auth'
import { resolveProvider } from '@/lib/ai/resolve'
import { db } from '@/lib/db'
import { topics } from '@/lib/db/schema'
import { workerStatus } from '@/lib/queue'
import { countReviewQueue, getDueCards } from '@/lib/review'

import ReviewSession from './review-client'

export const metadata = { title: 'Review · StudyBuddy' }

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ topic?: string | string[] }>
}) {
  const session = await auth()
  if (!session?.user?.id) redirect('/signin')

  const SITTING = 20

  const raw = (await searchParams).topic
  const requested = Array.isArray(raw) ? raw[0] : raw

  const [topic] = requested
    ? await db
        .select({ id: topics.id, name: topics.name })
        .from(topics)
        .where(eq(topics.id, requested))
        .limit(1)
    : []

  const topicId = topic?.id ?? null

  const [queue, waiting, resolved] = await Promise.all([
    getDueCards(db, session.user.id, SITTING, new Date(), topicId),
    countReviewQueue(db, session.user.id, new Date(), topicId),
    resolveProvider(db, session.user.id),
  ])

  const writerOffline =
    resolved.executor === 'operator_gpu' && !(await workerStatus(db)).online

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
      <PageHead
        eyebrow="Review"
        title={
          topic
            ? topic.name
            : waiting > 0
              ? `${waiting} ${waiting === 1 ? 'question' : 'questions'} due`
              : 'Nothing due today'
        }
      />

      {topic && (
        <p className="hint text-pretty">
          Only questions filed under this topic.{' '}
          <Link href="/review" className="text-accent underline underline-offset-2">
            Review everything due instead
          </Link>
          .
        </p>
      )}

      {queue.length > 0 && (
        <p className="hint mb-6 text-pretty">
          <span className="tabular-nums">
            {waiting > queue.length ? `${queue.length} of ${waiting}` : queue.length}
          </span>{' '}
          {waiting === 1 ? 'question is' : 'questions are'} due. Try to answer before
          revealing.
        </p>
      )}

      <ReviewSession
        items={queue}
        topicName={topic?.name ?? null}
        writerOffline={writerOffline}
      />
    </main>
  )
}
