'use client'

import Link from 'next/link'

import {AccuracyLabel} from '@/components/meter'
import {type TopicTreeNode} from '@/lib/ranking'

export function TopicTree({
  nodes,
  idBySlug,
  defaultOpenDepth = 0,
}: {
  nodes: TopicTreeNode[]
  idBySlug: ReadonlyMap<string, string>
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
        <span
          aria-hidden="true"
          className="shrink-0 text-xs text-muted group-open:rotate-90"
        >
          ▶
        </span>
        {label}
      </summary>

      <div className="ml-3 border-l pl-3">
        <TopicTree
          nodes={node.children}
          idBySlug={idBySlug}
          defaultOpenDepth={defaultOpenDepth}
        />
      </div>
    </details>
  )
}
