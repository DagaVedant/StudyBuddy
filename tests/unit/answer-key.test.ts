import { describe, expect, it } from 'vitest'

import { mergeAnswerKeys, parseAnswerKey } from '@/lib/questions/answer-key'

// The grid printed on the last page of edison_full_practice_test_45.
const GRID = `ANSWER KEY — PRACTICE TEST 1
1. D 2. C 3. A 4. C 5. B
6. B 7. C 8. C 9. D 10. A
11. C 12. A 13. B 14. A 15. D
Edison Academy Magnet School — STEM Entrance Practice Test 1 Page 7 of 7`

// The form the topic tests use, tags and all, straight from the text layer.
const SOLUTIONS = `Answer Key
<b>1.</b> B
<b>2.</b> D
<b>3.</b> A
Complete Solutions
1. Answer: B
Rectangle area = 12x10=120. The semicircle has radius 5, so its area is 39.25.
2. Answer: D
Circumference = 2x(22/7)x7 = 44. A uses only pi r instead of 2 pi r.
3. Answer: A
The exterior angle equals the sum of the two remote interior angles.`

describe('parseAnswerKey', () => {
  it('reads a key printed as a grid', () => {
    const key = parseAnswerKey(GRID)

    expect(key.get(1)).toBe('D')
    expect(key.get(10)).toBe('A')
    expect(key.get(15)).toBe('D')
    expect(key.size).toBe(15)
  })

  it('reads a key stated one line per worked solution, through inline tags', () => {
    const key = parseAnswerKey(SOLUTIONS)

    expect([...key]).toEqual([
      [1, 'B'],
      [2, 'D'],
      [3, 'A'],
    ])
  })

  it('accepts parenthesised labels', () => {
    const key = parseAnswerKey('1. (D) 2. (C) 3. (A) 4. (B)')

    expect(key.get(2)).toBe('C')
    expect(key.size).toBe(4)
  })

  // Everything below would answer a question against the wrong letter.

  it('finds nothing on a page of questions', () => {
    // Every one of these stems opens with a letter in the A-E range, which is
    // what a loose "number then letter" match trips over.
    const page = `1. A rectangular concrete slab has a width of 5 meters. What is its area?
A. 45
B. 90
2. A cleanroom floor is a rectangle whose sides are consecutive even integers.
A. $3,120
B. $5,280
3. Estimate the value of the expression above.
C. 360
D. 405`

    expect(parseAnswerKey(page).size).toBe(0)
  })

  it('ignores a page that yields only a stray match or two', () => {
    expect(parseAnswerKey('4. B').size).toBe(0)
    expect(parseAnswerKey('4. B 5. C').size).toBe(0)
  })

  it('drops a number the page answers two different ways', () => {
    const key = parseAnswerKey(`ANSWER KEY
1. D 2. C 3. A 4. B
1. Answer: B
2. Answer: C
3. Answer: A
4. Answer: B`)

    // 1 disagrees between the grid and the solutions; the rest agree.
    expect(key.has(1)).toBe(false)
    expect(key.get(2)).toBe('C')
    expect(key.get(3)).toBe('A')
    expect(key.get(4)).toBe('B')
  })

  it('says nothing about an empty page', () => {
    expect(parseAnswerKey('').size).toBe(0)
    expect(parseAnswerKey('   \n  ').size).toBe(0)
  })
})

describe('mergeAnswerKeys', () => {
  it('combines the keys spread across several pages', () => {
    const merged = mergeAnswerKeys([
      new Map([
        [1, 'A'],
        [2, 'B'],
      ]),
      new Map([
        [3, 'C'],
        [4, 'D'],
      ]),
    ])

    expect([...merged]).toEqual([
      [1, 'A'],
      [2, 'B'],
      [3, 'C'],
      [4, 'D'],
    ])
  })

  it('keeps a number the pages agree on', () => {
    const merged = mergeAnswerKeys([new Map([[7, 'C']]), new Map([[7, 'C']])])

    expect(merged.get(7)).toBe('C')
  })

  it('drops a number the pages contradict each other about', () => {
    const merged = mergeAnswerKeys([
      new Map([
        [7, 'C'],
        [8, 'A'],
      ]),
      new Map([[7, 'D']]),
    ])

    expect(merged.has(7)).toBe(false)
    expect(merged.get(8)).toBe('A')
  })
})
