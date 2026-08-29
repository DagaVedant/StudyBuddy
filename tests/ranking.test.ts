import {strict as assert} from 'node:assert'
import test from 'node:test'

import {buildTopicTree, summarize, type TopicStats, type TopicTreeNode} from '@/lib/ranking'

const LEAF = 'competition-math.algebra'

function statsFor(correct: number, unsure: number, wrong: number): TopicStats {
  return {
    topicId: 'topic-1',
    topicName: 'Algebra',
    topicPath: LEAF,
    subjectRoot: 'competition-math',
    correct,
    unsure,
    wrong,
    trend: null,
  }
}

function findNode(nodes: TopicTreeNode[], slug: string): TopicTreeNode | null {
  for (let node of nodes) {
    if (node.slug === slug) return node
    let found = findNode(node.children, slug)
    if (found) return found
  }
  return null
}

test('the topic tree and the dashboard report the same accuracy', () => {
  const stats = statsFor(5, 2, 5)

  const fromDashboard = summarize(stats)
  const node = findNode(buildTopicTree([stats]), LEAF)

  assert.ok(node, 'the taxonomy has no ' + LEAF + ' leaf')
  assert.equal(node.attempts, fromDashboard.attempts)
  assert.equal(
    node.accuracy,
    fromDashboard.accuracy,
    'the tree says ' + node.accuracy + ' and the dashboard says ' + fromDashboard.accuracy,
  )
})

test('unsure is not counted as correct', () => {
  const node = findNode(buildTopicTree([statsFor(5, 2, 5)]), LEAF)

  assert.ok(node)
  assert.equal(node.attempts, 12)
  assert.equal(node.accuracy, 5 / 12)
})

test('a topic nobody has attempted has no accuracy at all', () => {
  const node = findNode(buildTopicTree([statsFor(0, 0, 0)]), LEAF)

  assert.ok(node)
  assert.equal(node.attempts, 0)
  assert.equal(node.accuracy, null)
})
