import type { Db } from '@/lib/db/types'
import { applyAnswerKey } from '@/lib/worker/answer-key'
import { recoverCarriedChoices } from '@/lib/worker/carried-choices-apply'
import { mergeDuplicateQuestions } from '@/lib/worker/duplicates-apply'
import { joinSplitQuestions } from '@/lib/worker/join-splits'
import { renumberQuestions } from '@/lib/worker/renumber'
import { repairUnrenderedMath } from '@/lib/worker/repair-math'
import { repairPrintedNumbers } from '@/lib/worker/repair-numbers'

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
  
  duplicateNumbers: number[]
}

const NONE: RepairCounts = {
  joined: 0,
  recovered: 0,
  rendered: 0,
  repaired: 0,
  merged: 0,
  renumbered: 0,
  answered: 0,
  duplicateNumbers: [],
}

export interface RepairOptions {
  
  only?: readonly RepairPass[]
  
  log?: string | null
}

export async function runRepairPasses(
  db: Db,
  worksheetId: string,
  options: RepairOptions = {},
): Promise<RepairCounts> {
  const wanted = new Set<RepairPass>(options.only ?? ORDER)
  const log = options.log === undefined ? '' : options.log
  
  const counts: RepairCounts = { ...NONE, duplicateNumbers: [] }

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
        const { renumbered, duplicateNumbers } = await renumberQuestions(db, worksheetId)
        counts.renumbered = renumbered
        counts.duplicateNumbers = duplicateNumbers
        if (renumbered > 0) note(`[renumber] reordered ${renumbered} question(s)`)
        if (duplicateNumbers.length > 0) {
          note(`[renumber] printed number(s) claimed twice: ${duplicateNumbers.join(', ')}`)
        }
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

export const VERIFYING_PASSES = ['join', 'carried', 'math', 'merge'] as const

export const FINAL_PASSES = ORDER
