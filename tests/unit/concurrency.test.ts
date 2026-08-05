import { afterEach, describe, expect, it } from 'vitest'

import {
  PARALLEL_PAGE_THRESHOLD,
  PARALLEL_QUESTION_THRESHOLD,
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
  it('keeps a short worksheet sequential', () => {
    expect(concurrencyFor({ pageCount: 4, expectedQuestionCount: 10 })).toBe(1)
  })

  it('opens slots once the page count passes the threshold', () => {
    expect(concurrencyFor({ pageCount: PARALLEL_PAGE_THRESHOLD })).toBe(1)
    expect(concurrencyFor({ pageCount: PARALLEL_PAGE_THRESHOLD + 1 })).toBeGreaterThan(1)
  })

  // A dense paper is worth overlapping even when it is few pages, because the
  // cost is in the questions on them rather than in the page count.
  it('opens slots for a question-heavy but short paper', () => {
    expect(
      concurrencyFor({ pageCount: 6, expectedQuestionCount: PARALLEL_QUESTION_THRESHOLD + 1 }),
    ).toBeGreaterThan(1)
  })

  it('treats an unstated question count as no reason to parallelise', () => {
    expect(concurrencyFor({ pageCount: 3, expectedQuestionCount: null })).toBe(1)
    expect(concurrencyFor({ pageCount: 3 })).toBe(1)
  })

  it('takes the operator at their word', () => {
    process.env.OLLAMA_MAX_PARALLEL_PAGES = '3'
    expect(concurrencyFor({ pageCount: 40 })).toBe(3)
  })

  // Overflowing VRAM is not a gentle slowdown — an offloaded model measured
  // 9.2 tok/s against 79 — so a fat-fingered value must not be honoured.
  it('caps a wild setting rather than trusting it', () => {
    process.env.OLLAMA_MAX_PARALLEL_PAGES = '64'
    expect(concurrencyFor({ pageCount: 40 })).toBe(4)
  })

  it('never drops below one', () => {
    process.env.OLLAMA_MAX_PARALLEL_PAGES = '0'
    expect(maxParallelPages()).toBe(1)
    process.env.OLLAMA_MAX_PARALLEL_PAGES = 'banana'
    expect(maxParallelPages()).toBe(2)
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
