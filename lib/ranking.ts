import {MIN_ATTEMPTS} from '@/lib/upload'
import {flattenTaxonomy} from '@/lib/taxonomy'

export type TopicStats = {
  topicId: string
  topicName: string
  topicPath: string
  subjectRoot: string
  correct: number
  unsure: number
  wrong: number
  trend: string | null
}

export type RankedTopic = {
  topicId: string
  topicName: string
  topicPath: string
  subjectRoot: string
  correct: number
  unsure: number
  wrong: number
  trend: string | null
  attempts: number
  accuracy: number
  errorRate: number
  unsureRate: number
  score: number
  ranked: boolean
}

export type TopicTreeNode = {
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

function wrongScore(wrong: number, attempts: number) {
  if (attempts <= 0) return 0

  let z = 1.96
  let rate = wrong / attempts
  let bottom = 1 + (z * z) / attempts
  let middle = rate + (z * z) / (2 * attempts)
  let spread = z * Math.sqrt((rate * (1 - rate) + (z * z) / (4 * attempts)) / attempts)

  let score = (middle - spread) / bottom
  if (score < 0) return 0
  return score
}

export function summarize(stats: TopicStats) {
  let attempts = stats.correct + stats.unsure + stats.wrong

  let accuracy = 0
  let errorRate = 0
  let unsureRate = 0

  if (attempts > 0) {
    accuracy = stats.correct / attempts
    errorRate = stats.wrong / attempts
    unsureRate = stats.unsure / attempts
  }

  let topic: RankedTopic = {
    topicId: stats.topicId,
    topicName: stats.topicName,
    topicPath: stats.topicPath,
    subjectRoot: stats.subjectRoot,
    correct: stats.correct,
    unsure: stats.unsure,
    wrong: stats.wrong,
    trend: stats.trend,
    attempts: attempts,
    accuracy: accuracy,
    errorRate: errorRate,
    unsureRate: unsureRate,
    score: wrongScore(stats.wrong, attempts),
    ranked: attempts >= MIN_ATTEMPTS,
  }

  return topic
}

export function rankWeaknesses(stats: TopicStats[]) {
  let weak: RankedTopic[] = []

  for (let i = 0; i < stats.length; i++) {
    let topic = summarize(stats[i])
    if (topic.ranked && topic.wrong > 0) {
      weak.push(topic)
    }
  }

  weak.sort(function (a, b) {
    if (a.score !== b.score) return b.score - a.score
    if (a.errorRate !== b.errorRate) return b.errorRate - a.errorRate
    if (a.attempts !== b.attempts) return b.attempts - a.attempts
    if (a.topicPath < b.topicPath) return -1
    if (a.topicPath > b.topicPath) return 1
    return 0
  })

  return weak
}

export function buildTopicTree(stats: TopicStats[]) {
  let bySlug = new Map<string, TopicStats>()
  for (let i = 0; i < stats.length; i++) {
    bySlug.set(stats[i].topicPath, stats[i])
  }

  let flat = Array.from(flattenTaxonomy())
  flat.sort(function (a, b) {
    return a.depth - b.depth
  })

  let nodes = new Map<string, TopicTreeNode>()
  let roots: TopicTreeNode[] = []

  for (let topic of flat) {
    let node: TopicTreeNode = {
      slug: topic.slug,
      name: topic.name,
      depth: topic.depth,
      isLeaf: topic.isLeaf,
      correct: 0,
      unsure: 0,
      wrong: 0,
      attempts: 0,
      accuracy: null,
      ranked: false,
      children: [],
    }

    let own = bySlug.get(topic.slug)
    if (own) {
      node.correct = own.correct
      node.unsure = own.unsure
      node.wrong = own.wrong
    }

    nodes.set(topic.slug, node)

    let parent: TopicTreeNode | undefined
    if (topic.parentSlug) {
      parent = nodes.get(topic.parentSlug)
    }

    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  for (let i = flat.length - 1; i >= 0; i--) {
    let node = nodes.get(flat[i].slug)
    if (!node) continue

    for (let child of node.children) {
      node.correct += child.correct
      node.unsure += child.unsure
      node.wrong += child.wrong
    }

    node.attempts = node.correct + node.unsure + node.wrong

    if (node.attempts === 0) {
      node.accuracy = null
    } else {
      node.accuracy = (node.correct + node.unsure) / node.attempts
    }

    node.ranked = node.attempts >= MIN_ATTEMPTS
  }

  return roots
}
