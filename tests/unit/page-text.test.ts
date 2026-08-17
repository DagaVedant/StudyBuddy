import { describe, expect, it } from 'vitest'
import { headOf, seamAround, sortWithinPage, tailOf } from '@/lib/questions/page-text'
import { EXTRACTION_SYSTEM, extractionUserText } from '@/lib/ai/prompts'

describe('where a question starts on a page', () => {
const q = (
  name: string,
  printedNumber: number | null,
  top: number | null,
  position: number,
) => ({ name, printedNumber, top, position })

const order = (page: ReturnType<typeof q>[]) => sortWithinPage(page).map((row) => row.name)

describe('sortWithinPage', () => {
  
  
  it('trusts the number printed on the paper over the geometry', () => {
    expect(
      order([
        q('four', 4, 1428, 4),
        q('five', 5, 1379, 5),
        q('one', 1, 479, 1),
      ]),
    ).toEqual(['one', 'four', 'five'])
  })

  
  
  it('falls back to the layout when a question has no number', () => {
    expect(
      order([
        q('twelve', 12, 639, 12),
        q('orphan', null, 246, 15),
        q('thirteen', 13, 904, 13),
      ]),
    ).toEqual(['orphan', 'twelve', 'thirteen'])
  })

  it('falls back to arrival order when the layout is incomplete too', () => {
    expect(
      order([
        q('second', null, null, 2),
        q('first', null, 246, 1),
        q('third', 3, null, 3),
      ]),
    ).toEqual(['first', 'second', 'third'])
  })

  it('breaks a tie by arrival rather than leaving it to chance', () => {
    expect(order([q('late', 7, 100, 9), q('early', 7, 100, 2)])).toEqual(['early', 'late'])
  })

  it('leaves the caller its own array', () => {
    const page = [q('b', 2, 200, 2), q('a', 1, 100, 1)]
    sortWithinPage(page)

    expect(page.map((row) => row.name)).toEqual(['b', 'a'])
  })

  it('handles an empty page', () => {
    expect(sortWithinPage([])).toEqual([])
  })
})
})

describe('the seam between two pages', () => {
const page = {
  image: new Uint8Array([1]),
  mediaType: 'image/webp',
  width: 1000,
  height: 1400,
  pageNumber: 4,
  text: '14. What is the population of the city with the tallest bar?',
}

describe('tailOf and headOf', () => {
  it('pass a short page through whole', () => {
    expect(tailOf('one\ntwo')).toBe('one\ntwo')
    expect(headOf('one\ntwo')).toBe('one\ntwo')
  })

  
  it('cut on a line boundary rather than mid-word', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i} of the page`).join('\n')

    const tail = tailOf(lines, 100)
    const head = headOf(lines, 100)

    expect(tail.length).toBeLessThanOrEqual(100)
    expect(head.length).toBeLessThanOrEqual(100)
    expect(lines.endsWith(tail)).toBe(true)
    expect(lines.startsWith(head)).toBe(true)
    expect(tail.split('\n').every((l) => /^line \d+ of the page$/.test(l))).toBe(true)
    expect(head.split('\n').every((l) => /^line \d+ of the page$/.test(l))).toBe(true)
  })

  it('take from the correct end', () => {
    const text = ['first', 'middle'.repeat(30), 'last'].join('\n')

    expect(headOf(text, 40)).toContain('first')
    expect(headOf(text, 40)).not.toContain('last')
    expect(tailOf(text, 40)).toContain('last')
    expect(tailOf(text, 40)).not.toContain('first')
  })
})

describe('seamAround', () => {
  const pages = [
    { ocrText: 'page one' },
    { ocrText: 'page two' },
    { ocrText: 'page three' },
  ]

  it('hands back the page either side', () => {
    expect(seamAround(pages, 1)).toEqual({ before: 'page one', after: 'page three' })
  })

  it('gives the first page no before and the last no after', () => {
    expect(seamAround(pages, 0).before).toBe('')
    expect(seamAround(pages, 2).after).toBe('')
  })

  it('survives a page with no text layer, which a photo has', () => {
    expect(seamAround([{ ocrText: null }, { ocrText: 'x' }], 1)).toEqual({
      before: '',
      after: '',
    })
  })

  it('is indexed against the document, not the subset being read', () => {
    const all = [{ ocrText: 'p1' }, { ocrText: 'key' }, { ocrText: 'p3' }]

    expect(seamAround(all, 2).before).toBe('key')
  })
})

describe('the extraction prompt', () => {
  it('omits both blocks when there is no seam', () => {
    const text = extractionUserText(page)

    expect(text).not.toContain('previous_page_tail')
    expect(text).not.toContain('next_page_head')
  })

  it('fences each side separately and says which is which', () => {
    const text = extractionUserText({
      ...page,
      before: 'the bar chart, page 3',
      after: '(A) 1000 (B) 2000',
    })

    expect(text).toContain('<previous_page_tail>')
    expect(text).toContain('the bar chart, page 3')
    expect(text).toContain('<next_page_head>')
    expect(text).toContain('(A) 1000 (B) 2000')

    expect(text.indexOf('</page_text>')).toBeLessThan(text.indexOf('<previous_page_tail>'))
    expect(text.indexOf('<previous_page_tail>')).toBeLessThan(text.indexOf('<next_page_head>'))
  })

  it('labels both as context rather than content', () => {
    const text = extractionUserText({ ...page, before: 'x', after: 'y' })

    expect(text.match(/Context only, not content/g)).toHaveLength(2)
  })

  it('tells the model never to return a question from the neighbouring text', () => {
    expect(EXTRACTION_SYSTEM).toMatch(/never return a question that appears only in the neighbouring text/i)
    expect(EXTRACTION_SYSTEM).toMatch(/belongs to that page\. Return nothing for it/i)
  })

  it('keeps the re-read target alongside the seam rather than replacing it', () => {
    const text = extractionUserText({ ...page, before: 'x', after: 'y' }, [14, 15])

    expect(text).toContain('<previous_page_tail>')
    expect(text).toContain('questions 14, 15')
  })
})
})
