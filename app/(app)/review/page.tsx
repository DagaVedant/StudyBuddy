import { eq } from 'drizzle-orm'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { topics } from '@/lib/db/schema'
import { countReviewQueue, getDueCards } from '@/lib/review/queue'

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

  const [queue, waiting] = await Promise.all([
    getDueCards(db, session.user.id, SITTING, new Date(), topicId),
    countReviewQueue(db, session.user.id, new Date(), topicId),
  ])

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
      <h1 className="text-balance text-2xl font-semibold tracking-tight">
        {topic ? `Review: ${topic.name}` : 'Review'}
      </h1>

      {/*
        A filtered queue has to say so, and has to offer the way out. Otherwise
        a student who followed "Review these now" from a topic and found three
        questions has no way to tell that from having three questions due in
        total, and no way back to the rest without editing the URL.
      */}
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

      <ReviewSession items={queue} topicName={topic?.name ?? null} />
    </main>
  )
}
