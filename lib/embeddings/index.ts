import { existsSync } from 'node:fs'
import path from 'node:path'

import type { FeatureExtractionPipeline } from '@huggingface/transformers'

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2'
export const EMBEDDING_DIMENSIONS = 384

/**
 * Where `scripts/fetch-embedding-model.mjs` puts the weights, and where
 * `outputFileTracingIncludes` in next.config.ts copies them from.
 */
const VENDORED = path.join(process.cwd(), 'models')

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
    ({ env, pipeline }) => {
      /*
       * Read from the repo, not from huggingface.co.
       *
       * npm ships the runtime and none of the weights, so left alone this
       * downloads 23MB on first use into a cache inside node_modules. On a
       * developer machine that happens once. On a serverless host every cold
       * start is a fresh filesystem, so it happens inside `after()`, after the
       * response has gone, on a connection nothing is watching, and a failure
       * leaves the worksheet extracted with every question untagged.
       *
       * The build fetches the same four files into `models/` and traces them
       * into the bundle, so this is a disk read. `allowRemoteModels: false`
       * makes that a guarantee rather than a preference: a missing file is an
       * error here instead of a silent 23MB download.
       */
      if (existsSync(VENDORED)) {
        env.localModelPath = VENDORED
        env.allowRemoteModels = false
      }

      return pipeline('feature-extraction', EMBEDDING_MODEL, {
        dtype: 'q8',
      }) as Promise<FeatureExtractionPipeline>
    },
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
