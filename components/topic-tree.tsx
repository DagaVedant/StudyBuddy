import Link from 'next/link'

import { AccuracyLabel } from '@/components/meter'
import type { TopicTreeNode } from '@/lib/dashboard/topic-tree'

/**
 * spec.md:404's expandable subject drilldown, and the body of the topic index.
 *
 * `<details>` rather than client state. Expanding a tree is what the element is
 * for, it works before hydration, it is keyboard-operable and screen-reader
 * announced without any of that being written here, and the alternative is a
 * client component whose entire job is remembering which rows are open.
 *
 * Rows are links only where there is somewhere to go. A topic the taxonomy
 * knows about but the database has no row for cannot be opened, and a link that
 * 404s is worse than plain text.
 */
export default function TopicTree({
  nodes,
  idBySlug,
  defaultOpenDepth = 0,
}: {
  nodes: TopicTreeNode[]
  /** Slug to database id, for the topics that have a row. */
  idBySlug: ReadonlyMap<string, string>
  /** Levels expanded on arrival. 0 means subjects only. */
  defaultOpenDepth?: number
}) {
  return (
    <ul className="space-y-1">
      {nodes.map((node) => (
        <li key={node.slug}>
          <TopicRow
            node={node}
            idBySlug={idBySlug}
            defaultOpenDepth={defaultOpenDepth}
          />
        </li>
      ))}
    </ul>
  )
}

function TopicRow({
  node,
  idBySlug,
  defaultOpenDepth,
}: {
  node: TopicTreeNode
  idBySlug: ReadonlyMap<string, string>
  defaultOpenDepth: number
}) {
  const topicId = idBySlug.get(node.slug)

  const label = (
    <span className="flex min-w-0 flex-1 items-baseline gap-2">
      <span className="min-w-0 flex-1 truncate text-sm">{node.name}</span>
      {node.attempts > 0 ? (
        <AccuracyLabel
          accuracy={node.accuracy ?? 0}
          ranked={node.ranked}
          attempts={node.attempts}
        />
      ) : (
        // Never green, never red. spec.md:404 asks for "an explicit neutral
        // state for low-n", and no attempts at all is the lowest n there is.
        <span className="shrink-0 text-xs text-muted">Not started</span>
      )}
    </span>
  )

  if (node.children.length === 0) {
    return (
      <div className="flex items-baseline gap-2 py-1">
        {topicId ? (
          <Link
            href={`/topics/${topicId}`}
            className="flex min-w-0 flex-1 items-baseline gap-2 rounded hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {label}
          </Link>
        ) : (
          label
        )}
      </div>
    )
  }

  return (
    <details open={node.depth < defaultOpenDepth} className="group">
      <summary className="flex cursor-pointer items-baseline gap-2 rounded py-1 marker:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
        {/*
          The disclosure triangle, drawn rather than inherited. The native
          marker is a different glyph in every engine and cannot be positioned
          against a baseline-aligned row; `marker:content-['']` removes it.
        */}
        <span
          aria-hidden="true"
          className="shrink-0 text-xs text-muted transition-transform group-open:rotate-90"
        >
          ▶
        </span>
        {label}
      </summary>

      <div className="ml-3 border-l border-border pl-3">
        <TopicTree
          nodes={node.children}
          idBySlug={idBySlug}
          defaultOpenDepth={defaultOpenDepth}
        />
      </div>
    </details>
  )
}
