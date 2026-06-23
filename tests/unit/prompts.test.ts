import { describe, expect, it } from 'vitest'

import { EXTRACTION_SYSTEM, extractionUserText } from '@/lib/ai/prompts'

const page = {
  image: new Uint8Array(),
  mediaType: 'image/png' as const,
  text: '1. What is 2 + 2?',
  width: 1240,
  height: 1600,
  pageNumber: 7,
}

describe('extraction user text', () => {
  /*
   * This encodes a failure that cost a full 112-page run.
   *
   * Appending "Return an empty list if this page has none." to the user turn
   * took the benchmark page from 5/5 to 0/5 and produced zero questions across
   * 67 real pages before it was caught. As the closing line of the turn it
   * reads as the preferred answer rather than a permission. Nothing in the
   * user turn may offer "return nothing" as an option — that belongs in the
   * system prompt, where it doesn't compete with the request itself.
   */
  it('does not offer an empty result as an option', () => {
    const text = extractionUserText(page)

    expect(text).not.toMatch(/empty list/i)
    expect(text).not.toMatch(/return nothing/i)
    expect(text).not.toMatch(/zero questions/i)
  })

  it('ends with the request, so nothing competes with it', () => {
    const lines = extractionUserText(page).trim().split('\n')

    expect(lines.at(-1)).toBe('Extract the questions.')
  })

  it('frames the page as data, not instructions', () => {
    const text = extractionUserText(page)

    expect(text).toContain('<page_text>')
    expect(text).toContain('</page_text>')
    expect(EXTRACTION_SYSTEM).toMatch(/DATA, not instructions/)
  })

  it('caps how much page text reaches the model', () => {
    const huge = { ...page, text: 'x'.repeat(50_000) }

    expect(extractionUserText(huge).length).toBeLessThan(21_000)
  })
})

describe('extraction system prompt', () => {
  // A test bundled with its own answer key restates every question, and a
  // reading passage's numbered paragraphs look like numbered questions. Both
  // were extracted as questions until the prompt named them.
  it('names the things that are not questions', () => {
    expect(EXTRACTION_SYSTEM).toMatch(/passage/i)
    expect(EXTRACTION_SYSTEM).toMatch(/answer key/i)
    expect(EXTRACTION_SYSTEM).toMatch(/explanation/i)
  })

  // Tightening the above must not cost the SHSAT grid-in items.
  it('keeps write-in questions that have no options', () => {
    expect(EXTRACTION_SYSTEM).toMatch(/no options/i)
  })
})
