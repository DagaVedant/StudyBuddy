import Link from 'next/link'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { getDueCards } from '@/lib/review/queue'

import ReviewSession from './review-client'

export const metadata = { title: 'Review · StudyBuddy' }

export default async function ReviewPage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/signin')

  const queue = await getDueCards(db, session.user.id, 20)

  if (queue.length === 0) {
    return (
      <main className="mx-auto w-full max-w-2xl px-6 py-16 text-center">
        <h1 className="text-balance text-2xl font-semibold tracking-tight">
          Nothing Due
        </h1>
        <p className="hint mx-auto max-w-sm text-pretty">
          Everything you are tracking is scheduled for later. Upload another
          worksheet, or come back when something comes up for review.
        </p>
        <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
          <Link href="/upload" className="btn btn-primary sm:w-auto sm:px-6">
            Upload a Worksheet
          </Link>
          <Link href="/dashboard" className="btn btn-secondary sm:w-auto sm:px-6">
            Back to Dashboard
          </Link>
        </div>
      </main>
    )
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
      <h1 className="text-balance text-2xl font-semibold tracking-tight">Review</h1>
      <p className="hint mb-6 text-pretty">
        <span className="tabular-nums">{queue.length}</span>{' '}
        {queue.length === 1 ? 'question is' : 'questions are'} due. Try to answer
        before revealing.
      </p>

      <ReviewSession items={queue} />
    </main>
  )
}
