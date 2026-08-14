import { describe, expect, it } from 'vitest'

import type { TextLine } from '@/lib/db/schema'
import { roundLines } from '@/lib/questions/text-lines'

describe('roundLines', () => {
  it('rounds every coordinate in every line', () => {
    expect(
      roundLines([
        { text: 'hello', bbox: [56.79999999999995, 712.3200000000002, 90.1, 725.9] },
      ]),
    ).toEqual([{ text: 'hello', bbox: [57, 712, 90, 726] }])
  })

  it('keeps the text untouched', () => {
    expect(roundLines([{ text: 'Angle B = 65°', bbox: [0, 0, 1, 1] }])[0].text).toBe(
      'Angle B = 65°',
    )
  })

  it('treats null as no lines', () => {
    expect(roundLines(null)).toEqual([])
  })

  it('treats an empty array as no lines', () => {
    expect(roundLines([])).toEqual([])
  })

  it('preserves line order', () => {
    const lines: TextLine[] = [
      { text: 'first', bbox: [0, 0, 1, 1] },
      { text: 'second', bbox: [0, 10, 1, 11] },
    ]

    expect(roundLines(lines).map((l) => l.text)).toEqual(['first', 'second'])
  })
})
