import { describe, expect, it } from 'vitest'

import { TOPIC_REMAP } from '@/lib/taxonomy/remap'
import { flattenTaxonomy } from '@/lib/taxonomy/trees'

const flat = flattenTaxonomy()
const bySlug = new Map(flat.map((topic) => [topic.slug, topic]))

describe('the remap from the old taxonomy', () => {
  it('sends every mapping to a topic that exists', () => {
    const missing = Object.entries(TOPIC_REMAP)
      .filter(([, to]) => to !== null && !bySlug.has(to))
      .map(([from, to]) => `${from} -> ${to}`)

    expect(missing).toEqual([])
  })

  it('sends nothing to a topic that has children, which cannot be tagged', () => {
    const parents = Object.entries(TOPIC_REMAP)
      .filter(([, to]) => to !== null && bySlug.get(to)?.isLeaf === false)
      .map(([from, to]) => `${from} -> ${to}`)

    expect(parents).toEqual([])
  })

  it('maps away from the old trees only', () => {
    const stillHere = Object.keys(TOPIC_REMAP).filter((from) => bySlug.has(from))

    expect(stillHere).toEqual([])
  })

  it('does not map a slug to itself or in a chain', () => {
    const chained = Object.values(TOPIC_REMAP).filter(
      (to) => to !== null && to in TOPIC_REMAP,
    )

    expect(chained).toEqual([])
  })
})

describe('the taxonomy it maps into', () => {
  it('has only the three subjects this app is for', () => {
    const roots = flat.filter((topic) => topic.depth === 0).map((topic) => topic.slug)

    expect(roots).toEqual(['sat-math', 'sat-reading-and-writing', 'competition-math'])
  })

  it('keeps every leaf reachable from a root', () => {
    for (const topic of flat) {
      if (topic.parentSlug === null) continue
      expect(bySlug.has(topic.parentSlug)).toBe(true)
    }
  })
})
