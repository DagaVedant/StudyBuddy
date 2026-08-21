import { flattenTaxonomy } from '@/lib/taxonomy'

export const MIN_ATTEMPTS = 5

const Z = 1.96

export type TopicTrend = 'up' | 'down' | 'flat' | null

export interface TopicStats {
  topicId: string
  topicName: string
  topicPath: string
  subjectRoot: string
  correct: number
  unsure: number
  wrong: number
  trend: TopicTrend
}

export interface RankedTopic extends TopicStats {
  attempts: number
  accuracy: number
  errorRate: number
  unsureRate: number
  score: number
  ranked: boolean
}

export function wilsonLowerBound(successes: number, total: number, z: number = Z): number {
  if (total <= 0) return 0

  const phat = successes / total
  const z2 = z * z
  const denominator = 1 + z2 / total
  const centre = phat + z2 / (2 * total)
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * total)) / total)

  return Math.max(0, (centre - margin) / denominator)
}

export function summarize(stats: TopicStats): RankedTopic {
  const attempts = stats.correct + stats.unsure + stats.wrong
  const errors = stats.wrong

  return {
    ...stats,
    attempts,
    accuracy: attempts > 0 ? stats.correct / attempts : 0,
    errorRate: attempts > 0 ? errors / attempts : 0,
    unsureRate: attempts > 0 ? stats.unsure / attempts : 0,
    score: wilsonLowerBound(errors, attempts),
    ranked: attempts >= MIN_ATTEMPTS,
  }
}

export function rankWeaknesses(stats: TopicStats[]): RankedTopic[] {
  return stats
    .map(summarize)
    .filter((topic) => topic.ranked && topic.wrong > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.errorRate - a.errorRate ||
        b.attempts - a.attempts ||
        a.topicPath.localeCompare(b.topicPath),
    )
}

export function rankFragile(stats: TopicStats[]): RankedTopic[] {
  return stats
    .map(summarize)
    .filter((topic) => topic.ranked && topic.unsure > 0)
    .sort(
      (a, b) =>
        wilsonLowerBound(b.unsure, b.attempts) - wilsonLowerBound(a.unsure, a.attempts) ||
        b.unsureRate - a.unsureRate ||
        a.topicPath.localeCompare(b.topicPath),
    )
}

export function rollUp(
  stats: TopicStats[],
  keyOf: (stats: TopicStats) => string,
  labelOf: (stats: TopicStats) => string,
): RankedTopic[] {
  const buckets = new Map<string, TopicStats>()

  for (const entry of stats) {
    const key = keyOf(entry)
    const bucket = buckets.get(key) ?? {
      topicId: key,
      topicName: labelOf(entry),
      topicPath: labelOf(entry),
      subjectRoot: entry.subjectRoot,
      correct: 0,
      unsure: 0,
      wrong: 0,
      trend: null,
    }

    bucket.correct += entry.correct
    bucket.unsure += entry.unsure
    bucket.wrong += entry.wrong
    buckets.set(key, bucket)
  }

  return [...buckets.values()]
    .map(summarize)
    .sort((a, b) => a.topicPath.localeCompare(b.topicPath))
}

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
