/**
 * `lib/taxonomy/trees.ts`. The shape of the canonical tree, and the counts the
 * landing page quotes off it, which have to stay true as topics are added.
 */

import { describe, expect, it } from 'vitest'
import { TAXONOMY, flattenTaxonomy, nameBySlug, pathBySlug, type TopicNode } from '@/lib/taxonomy/trees'
import { SUBJECTS } from '@/components/dashboard-preview'
import { TOPICS } from '@/components/hero'

describe('the tree', () => {
describe('flattenTaxonomy', () => {
  const flat = flattenTaxonomy()

  it('produces globally unique slugs', () => {
    const slugs = flat.map((topic) => topic.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('throws rather than silently merging colliding siblings', () => {
    const colliding: TopicNode[] = [
      {
        name: 'Math',
        children: [{ name: 'Triangles' }, { name: 'triangles!' }],
      },
    ]
    expect(() => flattenTaxonomy(colliding)).toThrow(/Duplicate topic slug/)
  })

  it('covers the arithmetic the rest of the tree assumed', () => {
    const leaves = new Set(flat.filter((t) => t.isLeaf).map((t) => t.name))

    for (const name of [
      'Fraction operations',
      'Mixed numbers',
      'Ordering rational numbers',
      'Least common multiple',
      'Remainders and repeating patterns',
      'Successive percent change',
      'Cubes and cube roots',
      'Fundamental counting principle',
    ]) {
      expect(leaves, name).toContain(name)
    }
  })

  it('has somewhere to put a poetry question', () => {
    const poetry = flat.filter((t) => t.slug.startsWith('ela.poetry.'))
    expect(poetry.length).toBeGreaterThan(3)
    expect(poetry.map((t) => t.name)).toContain('Stanza and line structure')
  })

  it('does not leave percent work stranded under one exam', () => {
    const percent = flat.filter(
      (t) => t.isLeaf && t.slug.startsWith('high-school-math.') && /percent/i.test(t.name),
    )
    expect(percent.length).toBeGreaterThan(0)
  })

  it('nests slugs under their parent', () => {
    const leaf = flat.find((topic) => topic.name === 'Triangle angle sum')
    expect(leaf).toBeDefined()
    expect(leaf!.slug).toBe('high-school-math.geometry.triangles.triangle-angle-sum')
    expect(leaf!.parentSlug).toBe('high-school-math.geometry.triangles')
    expect(leaf!.subjectRoot).toBe('high-school-math')
    expect(leaf!.depth).toBe(3)
    expect(leaf!.isLeaf).toBe(true)
  })

  it('marks every parent as a non-leaf', () => {
    const parents = new Set(
      flat.map((topic) => topic.parentSlug).filter((slug): slug is string => !!slug),
    )
    for (const topic of flat) {
      if (parents.has(topic.slug)) expect(topic.isLeaf).toBe(false)
    }
  })

  it('gives every non-root a parent that exists', () => {
    const slugs = new Set(flat.map((topic) => topic.slug))
    for (const topic of flat) {
      if (topic.parentSlug) expect(slugs.has(topic.parentSlug)).toBe(true)
    }
  })

  it('seeds all four v1 subjects with a usable number of leaves', () => {
    const roots = flat.filter((topic) => topic.depth === 0).map((topic) => topic.slug)
    expect(roots).toEqual([
      'sat-math',
      'sat-reading-and-writing',
      'high-school-math',
      'ela',
    ])
    expect(flat.filter((topic) => topic.isLeaf).length).toBeGreaterThan(200)
  })

  it('builds a human-readable path for the dashboard', () => {
    const leaf = flat.find((topic) => topic.name === 'Law of cosines')
    expect(leaf?.path).toBe(
      'High School Math › Geometry › Right triangles and trigonometry › Law of cosines',
    )
  })

  it('exposes the taxonomy roots', () => {
    expect(TAXONOMY).toHaveLength(4)
  })
})

/**
 * Walking the tree is pure and the tree is a literal in the file, so it was
 * being rebuilt per request on four page routes, three of which then built a
 * `Map` over the result and threw that away too.
 */
describe('the flattened tree is built once', () => {
  it('hands back the same array every time', () => {
    expect(flattenTaxonomy()).toBe(flattenTaxonomy())
    expect(pathBySlug()).toBe(pathBySlug())
    expect(nameBySlug()).toBe(nameBySlug())
  })

  it('is frozen, since it is now shared rather than copied', () => {
    expect(Object.isFrozen(flattenTaxonomy())).toBe(true)
  })

  it('still walks a tree it is handed, so a broken one can be caught', () => {
    const custom: TopicNode[] = [{ name: 'Maths', children: [{ name: 'Circles' }] }]

    expect(flattenTaxonomy(custom)).not.toBe(flattenTaxonomy())
    expect(flattenTaxonomy(custom).map((topic) => topic.slug)).toEqual([
      'maths',
      'maths.circles',
    ])
  })

  it('agrees with the tree it was built from', () => {
    const leaf = flattenTaxonomy().find((topic) => topic.name === 'Law of cosines')!

    expect(pathBySlug().get(leaf.slug)).toBe(leaf.path)
    expect(nameBySlug().get(leaf.slug)).toBe('Law of cosines')
  })
})

/**
 * Segments are joined with dots into a path. An empty one leaves a trailing
 * dot, and every consumer then reads one level too many: `nearestAncestor`
 * splits on the dot and gets a blank last segment, and the shortlist's subtree
 * filter matches on a prefix ending in a separator.
 */
describe('a name that slugifies to nothing', () => {
  it('still contributes a segment', () => {
    const flat = flattenTaxonomy([{ name: 'Maths', children: [{ name: '???' }] }])

    expect(flat.map((topic) => topic.slug)).toEqual(['maths', 'maths.topic'])
  })

  it('does not leave a path ending in a separator', () => {
    const flat = flattenTaxonomy([{ name: '!!!', children: [{ name: '###' }] }])

    for (const topic of flat) {
      expect(topic.slug).not.toMatch(/\.$/)
      expect(topic.slug.split('.').every(Boolean)).toBe(true)
    }
  })
})
})

describe('the numbers the landing page quotes', () => {
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
})
