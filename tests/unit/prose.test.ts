import { describe, expect, it } from 'vitest'

import { blocksOf } from '@/components/prose'

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

  it('reads a single hash as a level 2 heading', () => {
    expect(blocksOf('# A title the model should not have written')).toEqual([
      { kind: 'heading', level: 2, text: 'A title the model should not have written' },
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
    expect(blocksOf('3 x 4 = 12')).toEqual([{ kind: 'paragraph', text: '3 x 4 = 12' }])
  })

  it('is empty for empty input', () => {
    expect(blocksOf('')).toEqual([])
    expect(blocksOf('\n\n  \n')).toEqual([])
  })

  it('treats html in the source as text', () => {
    expect(blocksOf('<script>alert(1)</script>')).toEqual([
      { kind: 'paragraph', text: '<script>alert(1)</script>' },
    ])
  })
})
