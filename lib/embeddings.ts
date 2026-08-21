import { existsSync } from 'node:fs'
import path from 'node:path'

import type { FeatureExtractionPipeline } from '@huggingface/transformers'

import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_INPUT_LIMIT,
  EMBEDDING_MODEL,
} from '@/lib/upload'

const VENDORED = path.join(process.cwd(), 'models')

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  extractorPromise ??= import('@huggingface/transformers').then(
    ({ env, pipeline }) => {
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

  const output = await extractor(trimmed.slice(0, EMBEDDING_INPUT_LIMIT), {
    pooling: 'mean',
    normalize: true,
  })

  return Array.from(output.data as Float32Array)
}
