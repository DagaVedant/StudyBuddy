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

  /*
   * spec.md:388's "free browsing by topic", which is the half of that line that
   * did not exist. `/review` took no arguments at all, so the topic page's
   * "Review these now" opened the global queue: a different set of questions
   * from the ones listed directly above the button, and quite possibly with
   * none of them in it.
   *
   * A repeated `?topic=` arrives as an array. Taking the first rather than
   * refusing, because the query string is a link somebody can hand-edit and one
   * topic is the obvious reading of two.
   */
  const raw = (await searchParams).topic
  const requested = Array.isArray(raw) ? raw[0] : raw

  // Looked up rather than trusted. The id is only useful here if it names a
  // real topic, and the name is wanted anyway to say which one is being
  // practised; an id that matches nothing falls back to the whole queue rather
  // than showing an empty screen with no explanation for it.
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

  /*
   * The empty queue is rendered by the client, not by a different tree here.
   *
   * This used to return its own "Nothing Due" page when the queue was empty,
   * which is right on arrival and wrong the moment it matters: finishing a
   * session calls `router.refresh()`, the refreshed queue is empty, and
   * swapping the tree unmounted the session component along with the count of
   * what had just been reviewed. A student who worked through twenty questions
   * was told everything was scheduled for later and never saw the total.
   *
   * Keeping the same component mounted across that boundary is what lets it
   * tell the two cases apart: it knows whether a session happened, and the
   * server cannot.
   */
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
          {/*
            "20 of 60" when the queue is longer than one sitting. It used to
            print the sitting as the total, so a student with sixty waiting saw
            sixty on the dashboard and twenty here, with nothing saying the two
            were counting different things.
          */}
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
