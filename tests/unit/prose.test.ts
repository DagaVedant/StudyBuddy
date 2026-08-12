import { describe, expect, it } from 'vitest'

import { blocksOf } from '@/components/prose'

/**
 * The block parser behind the lesson renderer.
 *
 * Everything it reads was written by a model, so the property that matters most
 * is what it does NOT do: there is no HTML parsing here at all, and anything
 * outside the small subset LESSON_SYSTEM asks for stays literal text rather
 * than becoming markup.
 */
describe('blocksOf', () => {
  it('reads a paragraph', () => {
    expect(blocksOf('Two sentences. On one line.')).toEqual([
      { kind: 'paragraph', text: 'Two sentences. On one line.' },
    ])
  })

  it('joins wrapped lines into one paragraph', () => {
    expect(blocksOf('a line\nand its continuation')).toEqual([
      { kind: 'paragraph', text: 'a line and its continuation' },
    ])
  })

  it('splits paragraphs on a blank line', () => {
    expect(blocksOf('first\n\nsecond')).toEqual([
      { kind: 'paragraph', text: 'first' },
      { kind: 'paragraph', text: 'second' },
    ])
  })

  it.each([
    ['## Section', 2],
    ['### Smaller', 3],
  ])('reads %s as a heading', (line, level) => {
    expect(blocksOf(line)).toEqual([
      { kind: 'heading', level, text: line.replace(/^#+\s+/, '') },
    ])
  })

  /** A top-level heading is not in the subset, so it stays text. */
  it('leaves a single hash as plain text', () => {
    expect(blocksOf('# Not a heading here')).toEqual([
      { kind: 'paragraph', text: '# Not a heading here' },
    ])
  })

  it('reads a bullet list', () => {
    expect(blocksOf('- one\n- two')).toEqual([
      { kind: 'list', ordered: false, items: ['one', 'two'] },
    ])
  })

  it('reads a numbered list', () => {
    expect(blocksOf('1. first\n2. second')).toEqual([
      { kind: 'list', ordered: true, items: ['first', 'second'] },
    ])
  })

  /**
   * Steps and bullets do not merge. A lesson often has a numbered method
   * followed by a bulleted aside, and running them together reads as one
   * nine-step method.
   */
  it('starts a new list when the kind changes', () => {
    expect(blocksOf('1. step\n- aside')).toEqual([
      { kind: 'list', ordered: true, items: ['step'] },
      { kind: 'list', ordered: false, items: ['aside'] },
    ])
  })

  it('ends a list at a paragraph', () => {
    expect(blocksOf('- one\nnow prose')).toEqual([
      { kind: 'list', ordered: false, items: ['one'] },
      { kind: 'paragraph', text: 'now prose' },
    ])
  })

  it('keeps maths that looks like a list marker', () => {
    // "3 x 4" and "1/2" must survive; only a marker followed by a space counts.
    expect(blocksOf('3 x 4 = 12')).toEqual([{ kind: 'paragraph', text: '3 x 4 = 12' }])
  })

  it('is empty for empty input', () => {
    expect(blocksOf('')).toEqual([])
    expect(blocksOf('\n\n  \n')).toEqual([])
  })

  /**
   * The safety property. Markup in the source is content, never structure:
   * this parser has no branch that produces HTML, so a model emitting a script
   * tag produces a paragraph containing that text.
   */
  it('treats html in the source as text', () => {
    expect(blocksOf('<script>alert(1)</script>')).toEqual([
      { kind: 'paragraph', text: '<script>alert(1)</script>' },
    ])
  })
})
