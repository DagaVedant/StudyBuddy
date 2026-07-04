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

  /*
   * These cover the material a real SHSAT form left untagged. Each name is a
   * question type that actually appeared and had nowhere to go — the failure
   * was silent, so it is worth asserting the homes exist.
   */
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

  /*
   * Percentages and unit conversion existed only under SAT Math, so a 12%
   * discount on a homework sheet had no home in the general maths tree.
   */
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
