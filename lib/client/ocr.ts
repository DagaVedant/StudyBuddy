import { createWorker, type Worker } from 'tesseract.js'

import type { TextLine } from '@/lib/db/schema'

import { throwIfCancelled, untilCancelled } from './abort'

let workerPromise: Promise<Worker> | null = null

async function getWorker(): Promise<Worker> {
  workerPromise ??= createWorker('eng')
  return workerPromise
}

export function preloadOcr(): void {
  void getWorker().catch(() => {
    workerPromise = null
  })
}

export interface OcrResult {
  text: string
  lines: TextLine[]
}

export async function ocrPage(image: Blob, signal?: AbortSignal): Promise<OcrResult> {
  throwIfCancelled(signal)

  const worker = await untilCancelled(getWorker(), signal)

  // Tesseract offers no way to interrupt a page mid-recognition, so cancelling
  // stops us waiting and then terminates the worker outright; otherwise the
  // wasted recognition keeps a core busy long after the user gave up. The next
  // upload lazily creates a fresh worker.
  let data
  try {
    ;({ data } = await untilCancelled(
      worker.recognize(image, {}, { text: true, blocks: true }),
      signal,
    ))
  } catch (cause) {
    if (signal?.aborted) void terminateOcr()
    throw cause
  }

  const lines: TextLine[] = []
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const text = line.text.trim()
        if (!text) continue
        lines.push({
          text,
          bbox: [line.bbox.x0, line.bbox.y0, line.bbox.x1, line.bbox.y1],
        })
      }
    }
  }

  return { text: data.text.replace(/\s+\n/g, '\n').trim(), lines }
}

export async function terminateOcr(): Promise<void> {
  if (!workerPromise) return
  const worker = await workerPromise.catch(() => null)
  workerPromise = null
  await worker?.terminate()
}
