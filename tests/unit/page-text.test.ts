/**
 * `lib/questions/page-text.ts`: where the first question starts on a page, and
 * the tail and head handed to the prompt so a question cut by a page break can
 * be read whole.
 */

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
  // AMC8 2024 page 1. The bboxes overlap and put question 4 below question 5,
  // which the numbers printed on the paper settle.
  it('trusts the number printed on the paper over the geometry', () => {
    expect(
      order([
        q('four', 4, 1428, 4),
        q('five', 5, 1379, 5),
        q('one', 1, 479, 1),
      ]),
    ).toEqual(['one', 'four', 'five'])
  })

  // AMC8 2024 page 3. The orphaned options have no number, so the numbers
  // cannot order the page and the layout has to.
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
/**
 * The seam: the neighbouring page text an extraction carries so a question that
 * ran over the fold can be read whole.
 *
 * The risk being managed is not that the model misses the join. It is that the
 * model reads the context as more page and returns the same question twice,
 * once from each side of the fold, which is worse than the split it fixes: a
 * duplicate reaches the student's paper, while a split is something the join
 * pass downstream already recovers.
 */

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

  /**
   * Trimmed to a line boundary at both ends. Half a word at the seam is a word
   * the model has to guess at, and guessing is the failure this exists to
   * remove.
   */
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

  /**
   * Indexed against the full page list, not a filtered loop. Answer-key pages
   * are skipped before extraction, and the page a question continued onto is
   * the one next to it in the document rather than the next one being read.
   */
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

    // Order matters for the reader: this page first, then its neighbours.
    expect(text.indexOf('</page_text>')).toBeLessThan(text.indexOf('<previous_page_tail>'))
    expect(text.indexOf('<previous_page_tail>')).toBeLessThan(text.indexOf('<next_page_head>'))
  })

  it('labels both as context rather than content', () => {
    const text = extractionUserText({ ...page, before: 'x', after: 'y' })

    expect(text.match(/Context only, not content/g)).toHaveLength(2)
  })

  /**
   * The instruction that stops a duplicate. Without it the model has every
   * reason to return the question it can see the end of at the top of the next
   * page, and the one it can see the start of at the bottom of the previous.
   */
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
