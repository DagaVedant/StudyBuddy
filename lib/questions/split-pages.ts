import { sortWithinPage, type PagePosition } from './page-text'
import { validateQuestion, type ValidatableQuestion } from './validate'

export interface SplitHalf extends ValidatableQuestion, PagePosition {
  id: string
  pageNumber: number | null
}

export interface SplitJoin {
  
  keepId: string
  
  dropId: string
  
  printedNumber: number | null
  
  reason: string
}

const CHOICE_BEARING = new Set(['multiple_choice', 'true_false'])

function flagCodes(question: ValidatableQuestion): Set<string> {
  return new Set(validateQuestion(question).map((flag) => flag.code))
}

function asksSomething(question: SplitHalf): boolean {
  const codes = flagCodes(question)
  return !codes.has('stem_is_not_a_question') && !codes.has('empty_stem')
}

function asksNothing(question: SplitHalf): boolean {
  return flagCodes(question).has('stem_is_not_a_question')
}

export function planPageSplitJoins(
  questions: SplitHalf[],
  options: { expectedChoiceCount?: number | null } = {},
): SplitJoin[] {
  const byPage = new Map<number, SplitHalf[]>()

  for (const question of questions) {
    
    if (question.pageNumber === null) continue
    byPage.set(question.pageNumber, [...(byPage.get(question.pageNumber) ?? []), question])
  }

  for (const [pageNumber, page] of byPage) byPage.set(pageNumber, sortWithinPage(page))

  const expected = options.expectedChoiceCount ?? null
  const joins: SplitJoin[] = []

  for (const pageNumber of [...byPage.keys()].sort((a, b) => a - b)) {
    const current = byPage.get(pageNumber)!
    
    
    
    const next = byPage.get(pageNumber + 1)
    if (!next || next.length === 0) continue

    const head = current[current.length - 1]
    const tail = next[0]

    
    
    if (!CHOICE_BEARING.has(head.questionType)) continue
    if (head.choices.length > 0) continue
    if (!asksSomething(head)) continue

    
    
    if (tail.choices.length < 2) continue
    if (!asksNothing(tail)) continue

    
    
    
    if (expected !== null && tail.choices.length !== expected) continue

    
    
    if (
      head.printedNumber !== null &&
      tail.printedNumber !== null &&
      head.printedNumber !== tail.printedNumber
    ) {
      continue
    }

    joins.push({
      keepId: head.id,
      dropId: tail.id,
      printedNumber: head.printedNumber ?? tail.printedNumber,
      reason:
        `question ${head.printedNumber ?? '?'} runs from page ${pageNumber} ` +
        `to page ${pageNumber + 1}: ${tail.choices.length} option(s) rejoined`,
    })
  }

  return joins
}
