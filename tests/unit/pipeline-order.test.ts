import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Finding 81's outstanding half: "nothing asserts both tiers run the same repair
 * sequence. There is no test importing lib/worker/pipeline.ts at all."
 *
 * The defect this guards against already happened once. The pass order existed
 * four times, in four different orders, and no two agreed on which passes ran:
 * Tier B was missing the split join and the carried-options recovery entirely,
 * so a question cut in half by a page break stayed cut in half for anyone using
 * their own cloud key. The fix was to make `ORDER` exist once and have
 * `runRepairPasses` filter it rather than iterate its caller's list. That is a
 * structural mitigation, which is better than a test, and it is not a test: this
 * is the part that fails if somebody makes the obvious change of looping over
 * `only` instead.
 *
 * Every pass is stubbed. The passes have their own tests; what is being measured
 * here is which of them run and in what order, and seeding real data for seven
 * of them would measure that far less directly.
 */

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

/** The canonical order, written out rather than imported, so a reordering fails. */
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

  /**
   * The order is a property of the pipeline, not of the caller's array. A
   * caller that lists them backwards still gets them forwards, which is what
   * makes `only` a filter rather than a schedule.
   */
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

/**
 * The finding's actual sentence: both tiers run the same repair sequence.
 *
 * Tier B calls `runRepairPasses` with no `only` at all, once, after extraction
 * (lib/worker/server-job.ts). The operator's GPU calls it twice through
 * `handlePhase`, with `VERIFYING_PASSES` and then `FINAL_PASSES`. So what has to
 * be true is that the GPU path's last run is the same set, in the same order, as
 * Tier B's only run.
 */
describe('the two tiers', () => {
  it('finish on the same sequence', async () => {
    // Tier B: the default, which is every pass.
    await runRepairPasses(db, 'w1', { log: null })
    const tierB = [...calls]

    calls.length = 0

    // The GPU path's closing run.
    await runRepairPasses(db, 'w1', { only: FINAL_PASSES, log: null })
    const operatorGpu = [...calls]

    expect(operatorGpu).toEqual(tierB)
    expect(operatorGpu).toEqual(CANONICAL)
  })

  /**
   * The earlier GPU run is deliberately narrower, and the reason is worth
   * pinning: the audit and the review pass both keep adding rows after it, and
   * anything they write takes the next free ordinal. Renumbering there is what
   * put a re-read question at 135 on a 114 question paper. So numbering and the
   * answer key are held back to the final run.
   */
  it('hold numbering back until the last re-read is in', async () => {
    await runRepairPasses(db, 'w1', { only: VERIFYING_PASSES, log: null })

    expect(calls).not.toContain('renumber')
    expect(calls).not.toContain('numbers')
    expect(calls).not.toContain('answers')
    expect(calls).toEqual(['join', 'carried', 'math', 'merge'])
  })

  /** A verifying pass that is not in the canonical order would never run. */
  it('keep the early set a subset of the final one', () => {
    for (const pass of VERIFYING_PASSES) {
      expect(FINAL_PASSES).toContain(pass)
    }
  })
})
