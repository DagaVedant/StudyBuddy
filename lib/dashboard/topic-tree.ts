import { flattenTaxonomy } from '@/lib/taxonomy/trees'

import { MIN_ATTEMPTS, type TopicStats } from './ranking'

export interface TopicTreeNode {
  slug: string
  name: string
  depth: number
  isLeaf: boolean
  /** Summed from this node and everything under it. */
  correct: number
  unsure: number
  wrong: number
  attempts: number
  /** Null until there is anything to divide by. */
  accuracy: number | null
  /** False below `MIN_ATTEMPTS`, which is the "not enough data yet" state. */
  ranked: boolean
  children: TopicTreeNode[]
}

/**
 * The taxonomy as a tree, with accuracy rolled up from children at every level.
 *
 * spec.md:404 asks panel 2 for exactly this: `Math → Geometry → Triangles →
 * Angle Relationships`, "accuracy at every level rolled up from children". What
 * the dashboard had was one `rollUp` call over `subjectRoot`, so only the top
 * level ever rendered and the three levels between a subject and a topic were
 * unreachable from that screen.
 *
 * Rolled up rather than read per level, because attempts only ever attach to
 * the leaf a question is filed under. A parent's number has to be the sum of
 * its descendants or it would be permanently zero.
 *
 * The whole taxonomy is walked, not just the parts with attempts, because this
 * doubles as the topic index (`/topics`): a student browsing for something to
 * study needs to see the topics they have never touched most of all. Callers
 * that only want what has been practised prune with `hasAttempts`.
 */
export function buildTopicTree(stats: TopicStats[]): TopicTreeNode[] {
  const bySlug = new Map(stats.map((row) => [row.topicPath, row]))
  const nodes = new Map<string, TopicTreeNode>()
  const roots: TopicTreeNode[] = []

  // Shallowest first, so a parent is always in `nodes` before its children ask
  // for it. `flattenTaxonomy` is already in that order, being a depth-first
  // walk from the roots, but sorting says so rather than relying on it.
  const flat = [...flattenTaxonomy()].sort((a, b) => a.depth - b.depth)

  for (const topic of flat) {
    const own = bySlug.get(topic.slug)

    const node: TopicTreeNode = {
      slug: topic.slug,
      name: topic.name,
      depth: topic.depth,
      isLeaf: topic.isLeaf,
      correct: own?.correct ?? 0,
      unsure: own?.unsure ?? 0,
      wrong: own?.wrong ?? 0,
      attempts: 0,
      accuracy: null,
      ranked: false,
      children: [],
    }

    nodes.set(topic.slug, node)

    const parent = topic.parentSlug ? nodes.get(topic.parentSlug) : null
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  // Deepest first, so every child is finished before its parent adds it in.
  for (const topic of [...flat].reverse()) {
    const node = nodes.get(topic.slug)!

    for (const child of node.children) {
      node.correct += child.correct
      node.unsure += child.unsure
      node.wrong += child.wrong
    }

    node.attempts = node.correct + node.unsure + node.wrong
    // `unsure` counts as correct: the answer was right. Whether it was confident
    // is the unsure-rate panel's question and has its own number.
    node.accuracy =
      node.attempts === 0 ? null : (node.correct + node.unsure) / node.attempts
    node.ranked = node.attempts >= MIN_ATTEMPTS
  }

  return roots
}

/** Whether anything under this node has been attempted at all. */
export function hasAttempts(node: TopicTreeNode): boolean {
  return node.attempts > 0
}

/**
 * The same tree with every branch that has never been attempted removed.
 *
 * For the dashboard, where the panel is answering "how am I doing" and a tree
 * of 341 topics the student has never seen answers nothing. `/topics` shows the
 * unpruned tree, because there the untouched topics are the point.
 */
export function pruneToAttempted(nodes: TopicTreeNode[]): TopicTreeNode[] {
  return nodes
    .filter(hasAttempts)
    .map((node) => ({ ...node, children: pruneToAttempted(node.children) }))
}
