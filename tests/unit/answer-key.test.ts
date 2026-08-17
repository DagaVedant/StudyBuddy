import { describe, expect, it } from 'vitest'

import { isAnswerPage, mergeAnswerKeys, parseAnswerKey } from '@/lib/questions/answer-key'

const GRID = `ANSWER KEY — PRACTICE TEST 1
1. D 2. C 3. A 4. C 5. B
6. B 7. C 8. C 9. D 10. A
11. C 12. A 13. B 14. A 15. D
Edison Academy Magnet School — STEM Entrance Practice Test 1 Page 7 of 7`

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

  it('finds nothing on a page of questions', () => {
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

describe('isAnswerPage', () => {
  it('calls a key page a key page', () => {
    expect(isAnswerPage(GRID)).toBe(true)
    expect(isAnswerPage(SOLUTIONS)).toBe(true)
  })

  it('calls a continuation of the solutions a key page', () => {
    const page = `4x 2 +12x+9 = (2x+3) 2 , so the side length is 2x+3, and the perimeter is 4(2x+3) = 8x + 12 . B reports the side length
instead of the perimeter. A doubles the side length instead of multiplying by 4.
20. Answer: B
Using (a+b) 2 = a 2 +2ab+b 2 : 20 2 = 218 + 2ab, so 400 - 218=2ab, giving ab= 91 . A repeats the given sum of squares.`

    expect(parseAnswerKey(page).size).toBe(0)
    expect(isAnswerPage(page)).toBe(true)
  })

  it('leaves a page of questions alone', () => {
    const page = `Section 2: Percents Practice
1. A price is increased by 20% and then decreased by 20%. What is the net percent change?
A. 0%
B. -20%
2. A jacket originally priced $80 is discounted 25%. What is the final price?
A. $54
B. $60`

    expect(isAnswerPage(page)).toBe(false)
  })

  it('keeps a page that prints questions and then its key', () => {
    const page = `19. A cyclist rides 12 km in 40 minutes. What is the average speed in km/h?
A. 15
B. 18
20. A tank holds 250 litres when it is five-eighths full. How much does it hold?
A. 400
B. 350
Answer Key
1. D 2. C 3. A 4. C 5. B`

    expect(isAnswerPage(page)).toBe(false)
  })

  it('says nothing about a page with no text', () => {
    expect(isAnswerPage('')).toBe(false)
    expect(isAnswerPage('   \n  ')).toBe(false)
    expect(isAnswerPage('Edison Academy Magnet School  Page 3 of 7')).toBe(false)
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
