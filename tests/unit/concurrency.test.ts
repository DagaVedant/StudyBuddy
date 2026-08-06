import { afterEach, describe, expect, it } from 'vitest'

import {
  PARALLEL_PAGE_THRESHOLD,
  concurrencyFor,
  mapWithConcurrency,
  maxParallelPages,
} from '@/lib/worker/concurrency'

const original = process.env.OLLAMA_MAX_PARALLEL_PAGES

afterEach(() => {
  if (original === undefined) delete process.env.OLLAMA_MAX_PARALLEL_PAGES
  else process.env.OLLAMA_MAX_PARALLEL_PAGES = original
})

describe('concurrencyFor', () => {
  // Parallel page reads are off. They were 1.7x faster and cost no extraction
  // accuracy, but ordinals are handed out as rows are written, so pages
  // finishing out of order left the student a list in the wrong order labelled
  // with numbers matching nothing on the page.
  it('reads one page at a time, whatever the size', () => {
    expect(concurrencyFor({ pageCount: 4, expectedQuestionCount: 10 })).toBe(1)
    expect(concurrencyFor({ pageCount: PARALLEL_PAGE_THRESHOLD + 1 })).toBe(1)
    expect(concurrencyFor({ pageCount: 200, expectedQuestionCount: 500 })).toBe(1)
  })

  it('cannot be turned back on by the environment alone', () => {
    process.env.OLLAMA_MAX_PARALLEL_PAGES = '4'
    expect(concurrencyFor({ pageCount: 200 })).toBe(1)
  })

  it('still caps the setting, for whenever ordering is fixed', () => {
    process.env.OLLAMA_MAX_PARALLEL_PAGES = '64'
    expect(maxParallelPages()).toBe(4)
    process.env.OLLAMA_MAX_PARALLEL_PAGES = '0'
    expect(maxParallelPages()).toBe(1)
  })
})

describe('mapWithConcurrency', () => {
  it('visits every item exactly once', async () => {
    const seen: number[] = []
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      seen.push(n)
    })

    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  })

  it('never runs more than the limit at once', async () => {
    let inFlight = 0
    let peak = 0

    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
    })

    expect(peak).toBe(3)
  })

  it('does not open more slots than there is work', async () => {
    let peak = 0
    let inFlight = 0

    await mapWithConcurrency([1, 2], 8, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
    })

    expect(peak).toBe(2)
  })

  it('handles an empty list', async () => {
    await expect(mapWithConcurrency([], 3, async () => {})).resolves.toBeUndefined()
  })

  it('runs sequentially at a limit of one', async () => {
    const order: number[] = []
    await mapWithConcurrency([1, 2, 3], 1, async (n) => {
      await new Promise((resolve) => setTimeout(resolve, 5 * (4 - n)))
      order.push(n)
    })

    expect(order).toEqual([1, 2, 3])
  })
})
