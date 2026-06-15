import { describe, expect, it } from 'vitest'

import {
  EMBEDDING_DIMENSIONS,
  cosineSimilarity,
  embed,
} from '@/lib/embeddings'

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 1], [1, 0, 1])).toBeCloseTo(1)
  })

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
  })

  it('handles zero vectors without dividing by zero', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })

  it('returns 0 on a dimension mismatch rather than throwing', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0)
  })
})

// Downloads ~23MB on first run, then reads from the local cache.
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
      // This is the property the classifier shortlist depends on: if it fails,
      // vector search returns nonsense candidates and classification degrades.
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
