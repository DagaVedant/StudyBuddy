import { describe, expect, it } from 'vitest'

import {
  MIN_ATTEMPTS,
  rankFragile,
  rankWeaknesses,
  rollUp,
  summarize,
  wilsonLowerBound,
  type TopicStats,
} from '@/lib/dashboard/ranking'
import { buildTopicTree, pruneToAttempted } from '@/lib/dashboard/topic-tree'

function stats(partial: Partial<TopicStats> & { topicId: string }): TopicStats {
  return {
    topicName: partial.topicId,
    topicPath: partial.topicId,
    subjectRoot: 'high-school-math',
    correct: 0,
    unsure: 0,
    wrong: 0,
    trend: null,
    ...partial,
  }
}

describe('wilsonLowerBound', () => {
  it('is zero with no observations', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0)
  })

  it('sits below the naive rate', () => {
    expect(wilsonLowerBound(8, 10)).toBeLessThan(0.8)
  })

  it('tightens toward the naive rate as the sample grows', () => {
    const small = wilsonLowerBound(8, 10)
    const large = wilsonLowerBound(800, 1000)
    expect(large).toBeGreaterThan(small)
    expect(large).toBeCloseTo(0.8, 1)
  })

  it('never goes negative', () => {
    expect(wilsonLowerBound(0, 50)).toBeGreaterThanOrEqual(0)
  })
})

describe('rankWeaknesses', () => {
  it('does not let a single miss outrank a sustained problem', () => {
    const ranked = rankWeaknesses([
      stats({ topicId: 'one-off', wrong: 1 }),
      stats({ topicId: 'real-problem', wrong: 12, correct: 28 }),
    ])

    expect(ranked[0].topicId).toBe('real-problem')
    expect(ranked.map((topic) => topic.topicId)).not.toContain('one-off')
  })

  it('excludes topics under the attempt floor', () => {
    const ranked = rankWeaknesses([
      stats({ topicId: 'thin', wrong: MIN_ATTEMPTS - 1 }),
      stats({ topicId: 'thick', wrong: MIN_ATTEMPTS }),
    ])
    expect(ranked.map((topic) => topic.topicId)).toEqual(['thick'])
  })

  it('excludes topics with no misses at all', () => {
    expect(rankWeaknesses([stats({ topicId: 'solid', correct: 20 })])).toHaveLength(0)
  })

  it('puts the worse of two equally-sampled topics first', () => {
    const ranked = rankWeaknesses([
      stats({ topicId: 'better', wrong: 5, correct: 15 }),
      stats({ topicId: 'worse', wrong: 15, correct: 5 }),
    ])
    expect(ranked[0].topicId).toBe('worse')
  })

  it('prefers the better-evidenced topic when rates tie', () => {
    const ranked = rankWeaknesses([
      stats({ topicId: 'small', wrong: 3, correct: 3 }),
      stats({ topicId: 'big', wrong: 30, correct: 30 }),
    ])
    expect(ranked[0].topicId).toBe('big')
  })
})

describe('summarize', () => {
  it('keeps unsure out of both accuracy and error rate', () => {
    const topic = summarize(stats({ topicId: 't', correct: 5, unsure: 3, wrong: 2 }))
    expect(topic.attempts).toBe(10)
    expect(topic.accuracy).toBe(0.5)
    expect(topic.errorRate).toBe(0.2)
    expect(topic.unsureRate).toBeCloseTo(0.3)
  })

  it('flags low-sample topics as unranked', () => {
    expect(summarize(stats({ topicId: 't', correct: 2 })).ranked).toBe(false)
    expect(summarize(stats({ topicId: 't', correct: 9 })).ranked).toBe(true)
  })

  it('handles a topic with no attempts without dividing by zero', () => {
    const topic = summarize(stats({ topicId: 'empty' }))
    expect(topic.accuracy).toBe(0)
    expect(topic.errorRate).toBe(0)
    expect(topic.score).toBe(0)
  })
})

describe('rankFragile', () => {
  it('surfaces high-accuracy topics that are actually being guessed', () => {
    const fragile = rankFragile([
      stats({ topicId: 'guessy', correct: 12, unsure: 8 }),
      stats({ topicId: 'known', correct: 20 }),
    ])
    expect(fragile[0].topicId).toBe('guessy')
    expect(fragile.map((topic) => topic.topicId)).not.toContain('known')
  })
})

describe('rollUp', () => {
  it('sums leaf stats into their parent bucket', () => {
    const rolled = rollUp(
      [
        stats({ topicId: 'a', subjectRoot: 'geo', correct: 4, wrong: 1 }),
        stats({ topicId: 'b', subjectRoot: 'geo', correct: 2, wrong: 3 }),
        stats({ topicId: 'c', subjectRoot: 'ela', correct: 1, wrong: 1 }),
      ],
      (entry) => entry.subjectRoot,
      (entry) => entry.subjectRoot,
    )

    const geo = rolled.find((topic) => topic.topicId === 'geo')!
    expect(geo.correct).toBe(6)
    expect(geo.wrong).toBe(4)
    expect(geo.attempts).toBe(10)
    expect(rolled).toHaveLength(2)
  })
})

describe('buildTopicTree', () => {
  const TRIANGLES = 'high-school-math.geometry.triangles.triangle-angle-sum'

  function subject(tree: ReturnType<typeof buildTopicTree>, slug: string) {
    const walk = (nodes: ReturnType<typeof buildTopicTree>): unknown => {
      for (const node of nodes) {
        if (node.slug === slug) return node
        const found = walk(node.children)
        if (found) return found
      }
      return null
    }
    return walk(tree) as ReturnType<typeof buildTopicTree>[number] | null
  }

  /**
   * spec.md:404's ask, and the reason the dashboard's old panel could only ever
   * render one level: attempts attach to the leaf a question is filed under, so
   * a parent's number has to be summed from its descendants or it is zero.
   */
  it('rolls a leaf’s attempts up through every ancestor', () => {
    const tree = buildTopicTree([
      stats({ topicId: 'x', topicPath: TRIANGLES, correct: 3, wrong: 1 }),
    ])

    for (const slug of [
      'high-school-math',
      'high-school-math.geometry',
      'high-school-math.geometry.triangles',
      TRIANGLES,
    ]) {
      expect(subject(tree, slug)).toMatchObject({ attempts: 4, correct: 3, wrong: 1 })
    }
  })

  it('counts unsure as correct, since the answer was right', () => {
    const tree = buildTopicTree([
      stats({ topicId: 'x', topicPath: TRIANGLES, correct: 1, unsure: 1, wrong: 2 }),
    ])

    expect(subject(tree, TRIANGLES)?.accuracy).toBe(0.5)
  })

  /** Never green, never red: spec.md:404 asks for an explicit neutral state. */
  it('leaves accuracy null and ranked false for a topic never attempted', () => {
    const tree = buildTopicTree([])

    expect(subject(tree, TRIANGLES)).toMatchObject({
      attempts: 0,
      accuracy: null,
      ranked: false,
    })
  })

  it('keeps every topic, so the index can show what has not been started', () => {
    const tree = buildTopicTree([])

    // The whole taxonomy, not just the parts with data.
    expect(tree.length).toBeGreaterThan(0)
    expect(subject(tree, TRIANGLES)).not.toBeNull()
  })

  it('prunes to the attempted branches for the dashboard panel', () => {
    const tree = pruneToAttempted(
      buildTopicTree([
        stats({ topicId: 'x', topicPath: TRIANGLES, correct: 1, wrong: 1 }),
      ]),
    )

    // One subject, one branch down to the one topic with anything in it.
    expect(tree).toHaveLength(1)
    expect(tree[0].slug).toBe('high-school-math')
    expect(subject(tree, 'high-school-math.algebra-1')).toBeNull()
    expect(subject(tree, TRIANGLES)).not.toBeNull()
  })
})
