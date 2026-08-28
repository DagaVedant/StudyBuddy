import Link from 'next/link'
import {redirect} from 'next/navigation'
import {PageHead} from '@/components/page-head'

import {auth} from '@/auth'
import {TopicTree} from '@/components/topic-tree'
import {db} from '@/lib/db'
import {getTopicStats} from '@/lib/dashboard'
import {buildTopicTree} from '@/lib/ranking'
import {topics} from '@/lib/schema'

export const metadata = {title: 'Topics · StudyBuddy'}

export default async function TopicsPage() {
  const session = await auth()
  if (!session || !session.user || !session.user.id) redirect('/signin')

  const [stats, rows] = await Promise.all([
    getTopicStats(db, session.user.id),
    db.select({id: topics.id, slug: topics.slug}).from(topics),
  ])

  const idBySlug = new Map<string, string>()
  for (const row of rows) idBySlug.set(row.slug, row.id)

  const tree = buildTopicTree(stats)

  return (
    <main className="w-full px-4 py-8 sm:px-6">
      <nav aria-label="Breadcrumb" className="mb-4 text-sm">
        <Link href="/dashboard" className="text-muted hover:text-fg">
          Dashboard
        </Link>
      </nav>

      <div className="mb-6">
        <PageHead title="Topics" />
      </div>

      {rows.length === 0 && (
        <p className="rounded-2xl card-sunk px-4 py-12 text-center text-sm text-muted">
          No topics have been set up yet.
        </p>
      )}

      {rows.length > 0 && (
        <TopicTree nodes={tree} idBySlug={idBySlug} defaultOpenDepth={1} />
      )}
    </main>
  )
}
