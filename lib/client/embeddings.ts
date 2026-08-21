import type { FeatureExtractionPipeline } from '@huggingface/transformers'

import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_INPUT_LIMIT,
  EMBEDDING_MODEL,
} from '@/lib/upload'

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  extractorPromise ??= import('@huggingface/transformers').then(({ env, pipeline }) => {
    env.allowLocalModels = false

    return pipeline('feature-extraction', EMBEDDING_MODEL, {
      dtype: 'q8',
    }) as Promise<FeatureExtractionPipeline>
  })

  return extractorPromise
}

export function preloadEmbeddings(): void {
  void getExtractor().catch(() => {
    extractorPromise = null
  })
}

export async function embedInBrowser(text: string): Promise<number[]> {
  const trimmed = text.trim()
  if (!trimmed) return new Array(EMBEDDING_DIMENSIONS).fill(0)

  const extractor = await getExtractor()

  const output = await extractor(trimmed.slice(0, EMBEDDING_INPUT_LIMIT), {
    pooling: 'mean',
    normalize: true,
  })

  return Array.from(output.data as Float32Array)
}

export async function disposeBrowserExtractor(): Promise<void> {
  const pending = extractorPromise
  if (!pending) return

  extractorPromise = null
  await (await pending).dispose()
}
