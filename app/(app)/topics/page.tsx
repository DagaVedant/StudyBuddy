import Link from 'next/link'
import {redirect} from 'next/navigation'
import {PageHead} from '@/components/ui'

import {auth} from '@/auth'
import {TopicTree} from '@/components/client'
import {db} from '@/lib/db'
import {getTopicStats} from '@/lib/dashboard'
import {buildTopicTree} from '@/lib/ranking'
import {topics} from '@/lib/db/schema'

export const metadata = {title: 'Topics · StudyBuddy'}

export default async function TopicsPage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/signin')

  const [stats, rows] = await Promise.all([
    getTopicStats(db, session.user.id),
    db.select({id: topics.id, slug: topics.slug}).from(topics),
  ])

  const idBySlug = new Map(rows.map((row) => [row.slug, row.id]))
  const tree = buildTopicTree(stats)

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

      <div className="mb-6">
        <PageHead
          title="Topics"
          lede="Everything StudyBuddy can sort a question into, with how you are doing on each. Open one to see the questions you have missed there, or to have a lesson written for it."
        />
      </div>

      {rows.length === 0 ? (
        <p className="rounded-2xl card-sunk px-4 py-12 text-center text-sm text-muted">
          No topics have been set up yet.
        </p>
      ) : (
        <TopicTree nodes={tree} idBySlug={idBySlug} defaultOpenDepth={1} />
      )}
    </main>
  )
}
