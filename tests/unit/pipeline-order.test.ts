import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => [] as string[])

const stub = (name: string, result: Record<string, unknown>) =>
  vi.fn(async () => {
    calls.push(name)
    return result
  })

vi.mock('@/lib/worker/join-splits', () => ({
  joinSplitQuestions: stub('join', { joined: 0 }),
}))
vi.mock('@/lib/worker/carried-choices-apply', () => ({
  recoverCarriedChoices: stub('carried', { recovered: 0 }),
}))
vi.mock('@/lib/worker/repair-math', () => ({
  repairUnrenderedMath: stub('math', { repaired: 0 }),
}))
vi.mock('@/lib/worker/repair-numbers', () => ({
  repairPrintedNumbers: stub('numbers', { repaired: 0 }),
}))
vi.mock('@/lib/worker/duplicates-apply', () => ({
  mergeDuplicateQuestions: stub('merge', { merged: 0 }),
}))
vi.mock('@/lib/worker/renumber', () => ({
  renumberQuestions: stub('renumber', { renumbered: 0, duplicateNumbers: [] }),
}))
vi.mock('@/lib/worker/answer-key', () => ({
  applyAnswerKey: stub('answers', { answered: 0 }),
}))

const { FINAL_PASSES, VERIFYING_PASSES, runRepairPasses } = await import(
  '@/lib/worker/pipeline'
)

const CANONICAL = ['join', 'carried', 'math', 'numbers', 'merge', 'renumber', 'answers']

const db = {} as never

beforeEach(() => {
  calls.length = 0
})

describe('the repair pipeline', () => {
  it('runs every pass, in the one order they are allowed to run in', async () => {
    await runRepairPasses(db, 'w1', { log: null })

    expect(calls).toEqual(CANONICAL)
  })

  it('ignores the order the caller asks for', async () => {
    await runRepairPasses(db, 'w1', {
      only: ['answers', 'renumber', 'merge', 'numbers', 'math', 'carried', 'join'],
      log: null,
    })

    expect(calls).toEqual(CANONICAL)
  })

  it('runs only what was asked for, still in order', async () => {
    await runRepairPasses(db, 'w1', { only: ['merge', 'join'], log: null })

    expect(calls).toEqual(['join', 'merge'])
  })
})

describe('the two tiers', () => {
  it('finish on the same sequence', async () => {
    await runRepairPasses(db, 'w1', { log: null })
    const tierB = [...calls]

    calls.length = 0

    await runRepairPasses(db, 'w1', { only: FINAL_PASSES, log: null })
    const operatorGpu = [...calls]

    expect(operatorGpu).toEqual(tierB)
    expect(operatorGpu).toEqual(CANONICAL)
  })

  it('hold numbering back until the last re-read is in', async () => {
    await runRepairPasses(db, 'w1', { only: VERIFYING_PASSES, log: null })

    expect(calls).not.toContain('renumber')
    expect(calls).not.toContain('numbers')
    expect(calls).not.toContain('answers')
    expect(calls).toEqual(['join', 'carried', 'math', 'merge'])
  })

  it('keep the early set a subset of the final one', () => {
    for (const pass of VERIFYING_PASSES) {
      expect(FINAL_PASSES).toContain(pass)
    }
  })
})
