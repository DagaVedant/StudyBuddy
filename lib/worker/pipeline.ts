import type { Db } from '@/lib/db/types'
import { applyAnswerKey } from '@/lib/worker/answer-key'
import { recoverCarriedChoices } from '@/lib/worker/carried-choices'
import { mergeDuplicateQuestions } from '@/lib/worker/dedupe'
import { joinSplitQuestions } from '@/lib/worker/join-splits'
import { renumberQuestions } from '@/lib/worker/renumber'
import { repairUnrenderedMath } from '@/lib/worker/repair-math'
import { repairPrintedNumbers } from '@/lib/worker/repair-numbers'

/**
 * The repair passes, in the one order they are allowed to run in.
 *
 * This existed four times (twice in the worker job route, once in the Tier B
 * server job, once in the audit script) in four different orders, and no two
 * of them agreed on which passes ran at all. Tier B was missing the split join
 * and the carried-options recovery entirely, so a question cut in half by a
 * page break stayed cut in half for anyone using their own cloud key. That is
 * not a subtle consequence of the duplication; it is the duplication.
 *
 * The order below is not arbitrary and is the reason this is one function
 * rather than a list callers assemble:
 *
 *   join      first, so a question the page break cut in two is whole before
 *             anything else counts it, numbers it, or offers it options.
 *   carried   after the join, so a question made whole from two rows is not
 *             handed the same options a second time off the page text.
 *   math      before the hash-sensitive passes: it rewrites mangled LaTeX and
 *             rehashes, so two copies of one question that differ only in
 *             whether `\frac` survived the JSON parser end up with the same
 *             content hash and the merge can actually see them as duplicates.
 *   numbers   before the renumber, because a recovered printed number changes
 *             where its question belongs in the order.
 *   merge     after the number repair, so the surviving row can inherit the
 *             number the phantom was occupying.
 *   renumber  after everything that adds, drops or moves rows.
 *   answers   last, and only here: it matches the paper's key on the printed
 *             number, so it has to run once every pass that can change a
 *             printed number has finished.
 */
const ORDER = [
  'join',
  'carried',
  'math',
  'numbers',
  'merge',
  'renumber',
  'answers',
] as const

export type RepairPass = (typeof ORDER)[number]

export interface RepairCounts {
  joined: number
  recovered: number
  rendered: number
  repaired: number
  merged: number
  renumbered: number
  answered: number
}

const NONE: RepairCounts = {
  joined: 0,
  recovered: 0,
  rendered: 0,
  repaired: 0,
  merged: 0,
  renumbered: 0,
  answered: 0,
}

export interface RepairOptions {
  /**
   * Which passes to run. Filters the canonical order; it does not reorder it,
   * which is the whole point. Defaults to all six.
   */
  only?: readonly RepairPass[]
  /** Prefix for the per-pass log lines. Pass null to stay quiet. */
  log?: string | null
}

/**
 * Runs the repair passes over one worksheet and reports what each one changed.
 *
 * Every pass is idempotent: running the set twice is how the job already
 * works, because a split only becomes visible once both halves are stored and
 * the review pass keeps adding rows after the first run.
 */
export async function runRepairPasses(
  db: Db,
  worksheetId: string,
  options: RepairOptions = {},
): Promise<RepairCounts> {
  const wanted = new Set<RepairPass>(options.only ?? ORDER)
  const log = options.log === undefined ? '' : options.log
  const counts: RepairCounts = { ...NONE }

  const note = (message: string) => {
    if (log !== null) console.log(`${log}${message} on ${worksheetId}`)
  }

  for (const pass of ORDER) {
    if (!wanted.has(pass)) continue

    switch (pass) {
      case 'join': {
        const { joined } = await joinSplitQuestions(db, worksheetId)
        counts.joined = joined
        if (joined > 0) note(`[split] rejoined ${joined} question(s)`)
        break
      }
      case 'carried': {
        const { recovered } = await recoverCarriedChoices(db, worksheetId)
        counts.recovered = recovered
        if (recovered > 0) note(`[carried] recovered options for ${recovered} question(s)`)
        break
      }
      case 'math': {
        const { repaired } = await repairUnrenderedMath(db, worksheetId)
        counts.rendered = repaired
        if (repaired > 0) note(`[maths] re-rendered ${repaired} question(s)`)
        break
      }
      case 'numbers': {
        const { repaired } = await repairPrintedNumbers(db, worksheetId)
        counts.repaired = repaired
        if (repaired > 0) note(`[numbers] recovered ${repaired} printed number(s)`)
        break
      }
      case 'merge': {
        const { merged } = await mergeDuplicateQuestions(db, worksheetId)
        counts.merged = merged
        if (merged > 0) note(`[dedupe] folded ${merged} duplicate question(s)`)
        break
      }
      case 'renumber': {
        const { renumbered } = await renumberQuestions(db, worksheetId)
        counts.renumbered = renumbered
        if (renumbered > 0) note(`[renumber] reordered ${renumbered} question(s)`)
        break
      }
      case 'answers': {
        const { answered } = await applyAnswerKey(db, worksheetId)
        counts.answered = answered
        if (answered > 0) note(`[key] answered ${answered} question(s) from the paper`)
        break
      }
    }
  }

  return counts
}

/**
 * The passes worth running before the audit reads the numbering.
 *
 * Numbering is deliberately left out: the audit and the review pass both still
 * add and replace rows after this point, and anything they write takes the next
 * free ordinal, which is what put a re-read question at 135 on a 114 question
 * paper. Renumbering happens once, at the end, in {@link FINAL_PASSES}, and the
 * answer key with it, since it can only match once the numbers have settled.
 */
export const VERIFYING_PASSES = ['join', 'carried', 'math', 'merge'] as const

/** Everything, run once the last re-read is in. */
export const FINAL_PASSES = ORDER
