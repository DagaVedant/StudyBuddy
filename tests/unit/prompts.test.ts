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

  it('names the missing questions on a retry', () => {
    const text = extractionUserText(page, [16, 17, 18])

    expect(text).toContain('16, 17, 18')
    expect(text).toMatch(/questions 16, 17, 18/)
    expect(text).toMatch(/every other question/i)
    expect(text.trim().split('\n').at(-1)).toBe('Extract the questions.')
  })

  it('says nothing about missing questions on a first pass', () => {
    expect(extractionUserText(page)).not.toMatch(/missed|should contain/i)
  })

  it('caps how much page text reaches the model', () => {
    const huge = { ...page, text: 'x'.repeat(50_000) }

    expect(extractionUserText(huge).length).toBeLessThan(21_000)
  })
})

describe('extraction system prompt', () => {
  it('names the things that are not questions', () => {
    expect(EXTRACTION_SYSTEM).toMatch(/passage/i)
    expect(EXTRACTION_SYSTEM).toMatch(/answer key/i)
    expect(EXTRACTION_SYSTEM).toMatch(/explanation/i)
  })

  it('keeps write-in questions that have no options', () => {
    expect(EXTRACTION_SYSTEM).toMatch(/no options/i)
  })
})
