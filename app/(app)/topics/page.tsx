import Link from 'next/link'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import TopicTree from '@/components/topic-tree'
import { db } from '@/lib/db'
import { getTopicStats } from '@/lib/dashboard/queries'
import { buildTopicTree } from '@/lib/dashboard/topic-tree'
import { topics } from '@/lib/db/schema'

export const metadata = { title: 'Topics · StudyBuddy' }

export default async function TopicsPage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/signin')

  const [stats, rows] = await Promise.all([
    getTopicStats(db, session.user.id),
    db.select({ id: topics.id, slug: topics.slug }).from(topics),
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

      <h1 className="text-balance text-2xl font-semibold tracking-tight">Topics</h1>
      <p className="hint mb-6 text-pretty">
        Everything StudyBuddy can sort a question into, with how you are doing on
        each. Open one to see the questions you have missed there, or to have a
        lesson written for it.
      </p>

      {rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border px-4 py-12 text-center text-sm text-muted">
          No topics have been set up yet.
        </p>
      ) : (
        <TopicTree nodes={tree} idBySlug={idBySlug} defaultOpenDepth={1} />
      )}
    </main>
  )
}
