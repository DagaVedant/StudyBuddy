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

/**
 * Releases the model and the ONNX session behind it.
 *
 * For long-lived processes that embed once and then go on to do something else,
 * and for the tests, which otherwise leave a ~25MB model and a native runtime
 * held open for the rest of the run. Nothing in a request path needs this: the
 * whole point of the cached promise is that the next request reuses it.
 */
export async function disposeExtractor(): Promise<void> {
  const pending = extractorPromise
  if (!pending) return

  extractorPromise = null
  await (await pending).dispose()
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
