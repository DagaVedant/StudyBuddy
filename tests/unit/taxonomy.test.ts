import { describe, expect, it } from 'vitest'

import { TAXONOMY, flattenTaxonomy, type TopicNode } from '@/lib/taxonomy/trees'

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
