import Link from 'next/link'
import { redirect } from 'next/navigation'

import { auth } from '@/auth'
import TopicTree from '@/components/topic-tree'
import { db } from '@/lib/db'
import { getTopicStats } from '@/lib/dashboard/queries'
import { buildTopicTree } from '@/lib/dashboard/topic-tree'
import { topics } from '@/lib/db/schema'

export const metadata = { title: 'Topics · StudyBuddy' }

/**
 * The topic index, which did not exist.
 *
 * There are 341 topics and 276 classifiable leaves, and a student could reach a
 * topic page in exactly two ways: by being ranked weak at it on the dashboard,
 * or by following a link from a question. There was no browse, no index and no
 * search. So the only route into the taxonomy was failing at something, and the
 * lesson feature sat behind that same door: `GenerateLessonButton` will write a
 * lesson for any topic, on a page most topics have no way of reaching.
 *
 * The whole tree renders, including the topics with nothing recorded against
 * them, because those are the point of an index. The dashboard's own panel
 * prunes to what has been attempted; this one does not.
 */
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
        // The taxonomy is seeded by an operator script, so an empty table is a
        // setup step nobody ran rather than a student with no data.
        <p className="rounded-2xl border border-dashed border-border px-4 py-12 text-center text-sm text-muted">
          No topics have been set up yet.
        </p>
      ) : (
        // Subjects open, everything under them closed. Six roots is a page you
        // can take in; 341 topics expanded is a wall.
        <TopicTree nodes={tree} idBySlug={idBySlug} defaultOpenDepth={1} />
      )}
    </main>
  )
}
