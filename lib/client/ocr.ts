import { createWorker, type Worker } from 'tesseract.js'

import type { TextLine } from '@/lib/db/schema'

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

export async function ocrPage(image: Blob): Promise<OcrResult> {
  const worker = await getWorker()
  const { data } = await worker.recognize(image, {}, { text: true, blocks: true })

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
