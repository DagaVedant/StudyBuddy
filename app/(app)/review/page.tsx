import {eq} from 'drizzle-orm'
import Link from 'next/link'
import {redirect} from 'next/navigation'
import {PageHead} from '@/components/page-head'

import {auth} from '@/auth'
import {resolveProvider} from '@/lib/ai/resolve'
import {db} from '@/lib/db'
import {topics} from '@/lib/schema'
import {workerStatus} from '@/lib/queue'
import {countReviewQueue, getDueCards} from '@/lib/review'

import ReviewSession from './review-client'

export const metadata = {title: 'Review · StudyBuddy'}

const SITTING = 20

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{topic?: string | string[]}>
}) {
  const session = await auth()
  if (!session || !session.user || !session.user.id) redirect('/signin')

  const raw = (await searchParams).topic

  let requested: string | undefined = undefined
  if (Array.isArray(raw)) requested = raw[0]
  else if (raw) requested = raw

  let topic = null

  if (requested) {
    const found = await db
      .select({id: topics.id, name: topics.name})
      .from(topics)
      .where(eq(topics.id, requested))
      .limit(1)

    if (found.length > 0) topic = found[0]
  }

  let topicId = null
  if (topic) topicId = topic.id

  const [queue, waiting, resolved] = await Promise.all([
    getDueCards(db, session.user.id, SITTING, new Date(), topicId),
    countReviewQueue(db, session.user.id, new Date(), topicId),
    resolveProvider(db, session.user.id),
  ])

  let writerOffline = false

  if (resolved.executor === 'operator_gpu') {
    const worker = await workerStatus(db)
    if (!worker.online) writerOffline = true
  }

  let heading = 'Nothing due today'

  if (topic) {
    heading = topic.name
  } else if (waiting > 0) {
    let noun = 'questions'
    if (waiting === 1) noun = 'question'

    heading = waiting + ' ' + noun + ' due'
  }

  let topicName = null
  if (topic) topicName = topic.name

  let shown = String(queue.length)
  if (waiting > queue.length) shown = queue.length + ' of ' + waiting

  return (
    <main className="w-full px-4 py-8 sm:px-6">
      <PageHead eyebrow="Review" title={heading} />

      {topic && (
        <p className="hint text-pretty">
          Only questions filed under this topic.{' '}
          <Link href="/review" className="text-accent">
            Review everything due instead
          </Link>
          .
        </p>
      )}

      {queue.length > 0 && (
        <p className="hint mb-6 text-pretty">
          <span className="tabular-nums">{shown}</span>{' '}
          {waiting === 1 ? 'question is' : 'questions are'} due. Try to answer before
          revealing.
        </p>
      )}

      <ReviewSession
        items={queue}
        topicName={topicName}
        writerOffline={writerOffline}
      />
    </main>
  )
}
