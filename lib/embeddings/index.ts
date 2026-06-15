import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers'

/**
 * Embeddings (spec §7.3).
 *
 * `Xenova/all-MiniLM-L6-v2`, 384 dimensions, ~23MB quantized. No embedding
 * API is ever called: this runs in the student's browser (Tier A/C), in the
 * job worker (Tier B), and on the operator GPU (Tier 0) — same model, so the
 * vectors are interchangeable across tiers.
 *
 * It also closes a real hole: Anthropic has no embeddings API, so a Tier B
 * user with an Anthropic key would otherwise have no embedding source at all.
 */

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2'
export const EMBEDDING_DIMENSIONS = 384

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  extractorPromise ??= pipeline('feature-extraction', EMBEDDING_MODEL, {
    dtype: 'q8',
  }) as Promise<FeatureExtractionPipeline>

  return extractorPromise
}

/** Warms the one-time model download so the first real call isn't slow. */
export function preloadEmbeddings(): void {
  void getExtractor().catch(() => {
    extractorPromise = null
  })
}

export async function embed(text: string): Promise<number[]> {
  const trimmed = text.trim()
  if (!trimmed) return new Array(EMBEDDING_DIMENSIONS).fill(0)

  const extractor = await getExtractor()

  // Mean pooling + L2 normalization is what MiniLM sentence embeddings expect;
  // normalized vectors also make cosine distance a plain dot product.
  const output = await extractor(trimmed.slice(0, 2000), {
    pooling: 'mean',
    normalize: true,
  })

  return Array.from(output.data as Float32Array)
}

export async function embedMany(texts: string[]): Promise<number[][]> {
  const results: number[][] = []
  for (const text of texts) {
    results.push(await embed(text))
  }
  return results
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0

  let dot = 0
  let magA = 0
  let magB = 0

  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }

  const denominator = Math.sqrt(magA) * Math.sqrt(magB)
  return denominator === 0 ? 0 : dot / denominator
}
