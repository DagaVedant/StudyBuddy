import { describe, expect, it } from 'vitest'

import { SUBJECTS } from '@/components/dashboard-preview'
import { TOPICS } from '@/components/hero'
import { flattenTaxonomy } from '@/lib/taxonomy/trees'

/**
 * The marketing page names four topics and says they are real taxonomy names.
 *
 * Three of them were not. `Ratio & proportion`, `Linear equations` and
 * `Reading inference` appear nowhere in the tree, so the one claim the page
 * made about its own honesty was the claim that was false, and a reader who
 * went looking for one of them found nothing.
 *
 * A comment cannot hold that. This can.
 */
describe('the topics named on the marketing page', () => {
  const leaves = [...flattenTaxonomy()].filter((node) => node.isLeaf)
  const names = new Set(leaves.map((node) => node.name))

  it.each(TOPICS.map((topic) => topic.name))('%s is a real leaf', (name) => {
    expect(names.has(name)).toBe(true)
  })

  // The counter animates up to a total the pills are supposed to explain, so a
  // pill edited without the total is a page that visibly does not add up.
  it('adds up to the total the counter lands on', () => {
    expect(TOPICS.reduce((sum, topic) => sum + topic.count, 0)).toBe(24)
  })
})

/**
 * The dashboard mock beside it makes a narrower claim: its By-subject panel is
 * a picture of what `rollUp` produces, and `rollUp` groups by `subjectRoot`.
 * There are four of those. The mock showed "Algebra 1", which is real but three
 * levels down the tree, so it advertised a row the product cannot draw.
 */
describe('the subjects in the dashboard mock', () => {
  const roots = new Set(
    [...flattenTaxonomy()].filter((node) => node.depth === 0).map((node) => node.name),
  )

  it.each(SUBJECTS.map((subject) => subject.name))(
    '%s is a subject root, not a topic',
    (name) => {
      expect(roots.has(name)).toBe(true)
    },
  )

  it('never shows a subject more correct than attempted', () => {
    for (const subject of SUBJECTS) {
      expect(subject.correct).toBeLessThanOrEqual(subject.attempts)
    }
  })
})
