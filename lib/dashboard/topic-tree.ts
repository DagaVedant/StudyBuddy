import { flattenTaxonomy } from '@/lib/taxonomy/trees'

import { MIN_ATTEMPTS, type TopicStats } from './ranking'

export interface TopicTreeNode {
  slug: string
  name: string
  depth: number
  isLeaf: boolean
  correct: number
  unsure: number
  wrong: number
  attempts: number
  accuracy: number | null
  ranked: boolean
  children: TopicTreeNode[]
}

export function buildTopicTree(stats: TopicStats[]): TopicTreeNode[] {
  const bySlug = new Map(stats.map((row) => [row.topicPath, row]))
  const nodes = new Map<string, TopicTreeNode>()
  const roots: TopicTreeNode[] = []

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

  for (const topic of [...flat].reverse()) {
    const node = nodes.get(topic.slug)!

    for (const child of node.children) {
      node.correct += child.correct
      node.unsure += child.unsure
      node.wrong += child.wrong
    }

    node.attempts = node.correct + node.unsure + node.wrong
    node.accuracy =
      node.attempts === 0 ? null : (node.correct + node.unsure) / node.attempts
    node.ranked = node.attempts >= MIN_ATTEMPTS
  }

  return roots
}

export function hasAttempts(node: TopicTreeNode): boolean {
  return node.attempts > 0
}

export function pruneToAttempted(nodes: TopicTreeNode[]): TopicTreeNode[] {
  return nodes
    .filter(hasAttempts)
    .map((node) => ({ ...node, children: pruneToAttempted(node.children) }))
}
