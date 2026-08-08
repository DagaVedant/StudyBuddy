import { describe, expect, it } from 'vitest'

import { EMBEDDING_DIMENSIONS, embed } from '@/lib/embeddings'

/**
 * Local to this file on purpose. Production never compares two vectors in
 * JavaScript: every similarity search goes through pgvector's `<=>` against an
 * HNSW index, in `lib/classify`. This exists only so the test below can state
 * what "related" means without a database.
 *
 * A plain dot product, because `embed` returns unit vectors (the test above
 * asserts that) and for those the two are the same number.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i]
  return dot
}

describe('embed (real MiniLM model)', () => {
  it(
    'produces normalized 384-dimension vectors',
    async () => {
      const vector = await embed('Find the measure of angle C in triangle ABC.')

      expect(vector).toHaveLength(EMBEDDING_DIMENSIONS)

      const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0))
      expect(magnitude).toBeCloseTo(1, 2)
    },
    120_000,
  )

  it(
    'places related topics closer than unrelated ones',
    async () => {
      const [triangles, angles, grammar] = await Promise.all([
        embed('Geometry › Triangles › Triangle angle sum'),
        embed('What is the measure of the third angle in a triangle?'),
        embed('ELA › Grammar and mechanics › Subject-verb agreement'),
      ])

      const related = cosineSimilarity(triangles, angles)
      const unrelated = cosineSimilarity(triangles, grammar)

      expect(related).toBeGreaterThan(unrelated)
      expect(related).toBeGreaterThan(0.4)
    },
    120_000,
  )

  it(
    'returns a zero vector for empty input instead of failing',
    async () => {
      const vector = await embed('   ')
      expect(vector).toHaveLength(EMBEDDING_DIMENSIONS)
      expect(vector.every((value) => value === 0)).toBe(true)
    },
    120_000,
  )
})
