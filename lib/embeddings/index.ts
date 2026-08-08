import type { FeatureExtractionPipeline } from '@huggingface/transformers'

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2'
export const EMBEDDING_DIMENSIONS = 384

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null

/**
 * Imported at call time, not at module load.
 *
 * @huggingface/transformers pulls in onnxruntime-node, which dlopen()s a
 * native .so. A top-level import therefore takes down every route that
 * transitively reaches this file, including ones that never embed anything,
 * the moment that library is missing, which is exactly what happens on a
 * serverless host that did not trace the binary into the bundle. Keeping the
 * import inside the function means only code that actually needs an embedding
 * can be hurt by its absence.
 */
async function getExtractor(): Promise<FeatureExtractionPipeline> {
  extractorPromise ??= import('@huggingface/transformers').then(
    ({ pipeline }) =>
      pipeline('feature-extraction', EMBEDDING_MODEL, {
        dtype: 'q8',
      }) as Promise<FeatureExtractionPipeline>,
  )

  return extractorPromise
}

export async function embed(text: string): Promise<number[]> {
  const trimmed = text.trim()
  if (!trimmed) return new Array(EMBEDDING_DIMENSIONS).fill(0)

  const extractor = await getExtractor()

  const output = await extractor(trimmed.slice(0, 2000), {
    pooling: 'mean',
    normalize: true,
  })

  return Array.from(output.data as Float32Array)
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
