import { describe, expect, it } from 'vitest'

import { extractionUserText, EXTRACTION_SYSTEM } from '@/lib/ai/prompts'
import { headOf, seamAround, tailOf } from '@/lib/questions/page-text'

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
