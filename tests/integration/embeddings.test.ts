import { afterAll, describe, expect, it } from 'vitest'

import { EMBEDDING_DIMENSIONS, disposeExtractor, embed } from '@/lib/embeddings'

/**
 * Local to this file on purpose. Production never compares two vectors in
 * JavaScript: every similarity search goes through pgvector's `<=>` against an
 * HNSW index, in `lib/classify`. This exists only so the test below can state
 * what "related" means without a database.
 *
 * A plain dot product, because `embed` returns unit vectors (the test below
 * asserts that) and for those the two are the same number.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i]
  return dot
}

/**
 * This one never loads the model: `embed` returns the zero vector for blank
 * input before it asks for an extractor. So it runs everywhere, always, and it
 * is the guard on the branch a caller is most likely to hit by accident.
 */
describe('embed', () => {
  it('returns a zero vector for empty input instead of failing', async () => {
    const vector = await embed('   ')

    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS)
    expect(vector.every((value) => value === 0)).toBe(true)
  })
})

/**
 * Gated, because these download a ~25MB ONNX model on first run.
 *
 * Ungated they made `npm run check` depend on the network and on Hugging Face
 * being up: a machine with no connection failed here with a 120-second timeout,
 * which reads exactly like a product bug and is not one. Run them deliberately:
 *
 *   RUN_MODEL_TESTS=1 npx vitest run tests/integration/embeddings.test.ts
 *
 * They are worth running whenever `lib/embeddings` changes, and before trusting
 * a shortlist-recall measurement, since both rest on this model being the one
 * the numbers were measured against.
 */
const MODEL_TESTS = Boolean(process.env.RUN_MODEL_TESTS)

describe.skipIf(!MODEL_TESTS)('embed (real MiniLM model)', () => {
  // The pipeline is cached in module scope and holds the model and a native
  // ONNX session, which would otherwise stay resident for the rest of the run.
  afterAll(async () => {
    await disposeExtractor()
  })

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
})
