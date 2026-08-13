import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { countReviewQueue, getDueCards } from '@/lib/review/queue'

import ReviewSession from './review-client'

export const metadata = { title: 'Review · StudyBuddy' }

export default async function ReviewPage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/signin')

  const SITTING = 20

  const [queue, waiting] = await Promise.all([
    getDueCards(db, session.user.id, SITTING),
    countReviewQueue(db, session.user.id),
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
      <h1 className="text-balance text-2xl font-semibold tracking-tight">Review</h1>
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

      <ReviewSession items={queue} />
    </main>
  )
}
