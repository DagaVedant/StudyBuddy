import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RasterPage } from '@/lib/client/rasterize'
import { pageInRange } from '@/lib/upload/page-range'

/**
 * Covers which pages an upload actually selects.
 *
 * The arithmetic that decides this spans two modules — rasterizePdf skips by
 * document-wide number, ingestWorksheet accumulates the offset across files —
 * and neither half is meaningful alone. pdf.js and canvas can't run here, so
 * rasterization is mocked and only the selection is under test.
 */

const rendered: number[] = []

function fakePage(pageNumber: number): RasterPage {
  return {
    pageNumber,
    blob: new Blob(['x']),
    width: 100,
    height: 100,
    // Enough to read as born-digital so OCR is skipped.
    embeddedText: 'x'.repeat(200),
    embeddedLines: [],
  }
}

vi.mock('@/lib/client/rasterize', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/client/rasterize')>()

  return {
    ...actual,
    hasUsableTextLayer: () => true,
    rasterizePdf: vi.fn(
      async (
        file: File,
        _onProgress: unknown,
        options: { offset?: number; range?: { from: number; to: number | null } | null } = {},
      ) => {
        const { offset = 0, range = null } = options
        // Page count is encoded in the fixture's name.
        const totalPages = Number(file.name.match(/(\d+)p/)?.[1] ?? 1)
        const pages: RasterPage[] = []

        for (let n = 1; n <= totalPages; n += 1) {
          if (!pageInRange(offset + n, range)) continue
          rendered.push(offset + n)
          pages.push(fakePage(offset + n))
        }

        return { pages, totalPages }
      },
    ),
    rasterizeImage: vi.fn(async (_file: File, pageNumber: number) => {
      rendered.push(pageNumber)
      return fakePage(pageNumber)
    }),
  }
})

vi.mock('@/lib/client/ocr', () => ({
  preloadOcr: () => {},
  ocrPage: async () => ({ text: '', lines: [] }),
  terminateOcr: async () => {},
}))

const { ingestWorksheet } = await import('@/lib/client/ingest')

function pdf(name: string) {
  return new File(['%PDF'], name, { type: 'application/pdf' })
}

function image(name: string) {
  return new File(['x'], name, { type: 'image/png' })
}

beforeEach(() => {
  rendered.length = 0

  let pageSeq = 0
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input)
    const body = url.includes('/complete')
      ? { next: '/done' }
      : url.includes('/pages')
        ? { pageId: `page-${(pageSeq += 1)}` }
        : { worksheetId: 'ws-1' }

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
})

async function ingest(files: File[], pageRange: { from: number; to: number | null } | null) {
  return ingestWorksheet({
    files,
    title: 'Test',
    pageRange,
    onProgress: () => {},
  })
}

describe('ingestWorksheet page range', () => {
  it('renders every page when no range is given', async () => {
    await ingest([pdf('form-5p.pdf')], null)
    expect(rendered).toEqual([1, 2, 3, 4, 5])
  })

  // The case this was built for: a practice form whose test section ends
  // partway through, followed by an explanations section.
  it('never renders a page outside the range', async () => {
    const result = await ingest([pdf('form-10p.pdf')], { from: 1, to: 4 })

    expect(rendered).toEqual([1, 2, 3, 4])
    expect(result.pageCount).toBe(4)
  })

  it('keeps the document numbering when the range starts partway in', async () => {
    const result = await ingest([pdf('form-10p.pdf')], { from: 7, to: null })

    expect(rendered).toEqual([7, 8, 9, 10])
    expect(result.pageCount).toBe(4)
  })

  /*
   * The offset must advance by every page in a file, not by the pages kept.
   * Counting only kept pages would shift the numbering under the range and
   * silently select the wrong pages in the next file.
   */
  it('numbers pages across several files as one document', async () => {
    await ingest([pdf('a-3p.pdf'), pdf('b-4p.pdf')], { from: 3, to: 5 })

    expect(rendered).toEqual([3, 4, 5])
  })

  it('applies the range to loose images too', async () => {
    await ingest([pdf('a-2p.pdf'), image('photo-1.png'), image('photo-2.png')], {
      from: 3,
      to: 3,
    })

    expect(rendered).toEqual([3])
  })

  it('explains itself when the range selects nothing', async () => {
    await expect(ingest([pdf('form-5p.pdf')], { from: 40, to: 50 })).rejects.toThrow(
      /No pages in pages 40–50.*has 5 pages/,
    )
  })
})
