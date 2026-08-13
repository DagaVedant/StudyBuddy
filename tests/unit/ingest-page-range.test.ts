import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RasterPage } from '@/lib/client/rasterize'

/** Every page the mock was allowed to hand back, in order. */
const rendered: number[] = []

/** What `ingestWorksheet` asked each PDF to be rasterized with. */
const asked: { name: string; offset: number; range: unknown }[] = []

function fakePage(pageNumber: number): RasterPage {
  return {
    pageNumber,
    blob: new Blob(['x']),
    width: 100,
    height: 100,

    embeddedText: 'x'.repeat(200),
    embeddedLines: [],
  }
}

vi.mock('@/lib/client/rasterize', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/client/rasterize')>()

  return {
    ...actual,
    hasUsableTextLayer: () => true,
    /**
     * A stand-in rasterizer that states the range rule itself, in arithmetic,
     * rather than calling the one the real one calls.
     *
     * It used to run `pageInRange(offset + n, range)`, which is the same line
     * `rasterize.ts` runs, so the tests measured the production function
     * against itself. The comment here already said it did not, which is worse
     * than either: it read as covered.
     *
     * It cannot be dumb, because a rasterizer that returns out-of-range pages
     * is not one this code ever meets, and the "range selects nothing" case
     * below needs it to behave. So it keeps the behaviour and owns the rule,
     * which makes this file an independent statement of what `ingestWorksheet`
     * expects from a rasterizer instead of an echo of one.
     *
     * The real loop cannot be reached from here. `getPdfjs` loads pdf.js
     * through `new Function('url', 'return import(url)')`, which exists to keep
     * the bundler out of it and which no module mock can intercept, so the
     * filtering itself is covered where the real rasterizer actually runs: by
     * `pageInRange` and `countInRange` directly in page-range.test.ts, and end
     * to end by journey.spec.ts, which rasterizes a real PDF in a browser.
     *
     * What is left here is what belongs to `ingestWorksheet` alone: the offset
     * it hands each file, which is the running page count of everything before
     * it, and the range it passes down untouched.
     */
    rasterizePdf: vi.fn(
      async (
        file: File,
        _onProgress: unknown,
        options: { offset?: number; range?: { from: number; to: number | null } | null } = {},
      ) => {
        const { offset = 0, range = null } = options
        asked.push({ name: file.name, offset, range })

        const totalPages = Number(file.name.match(/(\d+)p/)?.[1] ?? 1)
        const pages: RasterPage[] = []

        for (let n = 1; n <= totalPages; n += 1) {
          const page = offset + n

          // Spelled out rather than shared with the code under test.
          if (range && page < range.from) continue
          if (range && range.to !== null && page > range.to) continue

          rendered.push(page)
          pages.push(fakePage(page))
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
  asked.length = 0

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

  it('numbers pages across several files as one document', async () => {
    await ingest([pdf('a-3p.pdf'), pdf('b-4p.pdf')], { from: 3, to: 5 })

    expect(rendered).toEqual([3, 4, 5])
  })

  /**
   * The part that is `ingestWorksheet`'s own, and the part the mock cannot fake
   * for it: each file is rasterized at the running page count of everything
   * before it, and the range goes down untouched. Get the offset wrong and a
   * range spanning a file boundary silently selects the wrong pages, which no
   * assertion on the rendered numbers would catch if the mock were also the
   * thing computing them.
   */
  it('hands each file the running page count and the range as given', async () => {
    const range = { from: 3, to: 5 }
    await ingest([pdf('a-3p.pdf'), pdf('b-4p.pdf'), pdf('c-2p.pdf')], range)

    expect(asked).toEqual([
      { name: 'a-3p.pdf', offset: 0, range },
      { name: 'b-4p.pdf', offset: 3, range },
      { name: 'c-2p.pdf', offset: 7, range },
    ])
  })

  it('passes no range when none was chosen', async () => {
    await ingest([pdf('a-2p.pdf'), pdf('b-2p.pdf')], null)

    expect(asked.map((call) => call.range)).toEqual([null, null])
    expect(asked.map((call) => call.offset)).toEqual([0, 2])
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
