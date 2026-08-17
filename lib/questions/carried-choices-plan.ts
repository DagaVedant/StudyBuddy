import { normalizeMath } from './math'
import { firstQuestionAt } from './page-text'

export interface CarriedChoice {
  label: string
  text: string
}

const OPTION = /(?<![\p{L}\p{N}])\(?([A-Za-z])[).][ \t]+/gu

const MAX_OPTION_TEXT = 300

const A = 'A'.charCodeAt(0)

function heldLabels(raw: string[]): string[] {
  const letters = raw
    .map((label) => label.trim().toUpperCase())
    .filter((label) => /^[A-Z]$/.test(label))

  return [...new Set(letters)].sort()
}

export interface CarriedChoiceOptions {
  
  expectedCount?: number | null
  
  held?: string[]
}

export function parseCarriedChoices(
  pageText: string,
  options: CarriedChoiceOptions = {},
): CarriedChoice[] | null {
  const text = pageText ?? ''
  if (text.trim().length === 0) return null

  const expected = options.expectedCount ?? null
  const held = heldLabels(options.held ?? [])

  let startCode = A
  let need: number | null = expected

  if (held.length > 0) {
    
    
    
    if (!held.every((label, index) => label.charCodeAt(0) === A + index)) return null
    
    
    if (expected === null || held.length >= expected) return null

    startCode = A + held.length
    need = expected - held.length
  }

  const limit = firstQuestionAt(text)
  
  
  const head = text.slice(0, limit)
  if (head.trim().length === 0) return null

  const marks: { label: string; at: number; textFrom: number }[] = []
  OPTION.lastIndex = 0

  for (let match = OPTION.exec(head); match; match = OPTION.exec(head)) {
    marks.push({
      label: match[1].toUpperCase(),
      at: match.index,
      textFrom: match.index + match[0].length,
    })
  }

  
  
  
  
  const minimum = held.length > 0 ? need! : 3
  if (marks.length < minimum) return null

  const start = marks.findIndex((mark) => mark.label.charCodeAt(0) === startCode)
  if (start === -1) return null

  
  
  
  if (held.length > 0 && start !== 0) return null

  const run: CarriedChoice[] = []
  let expectedCode = startCode

  for (let index = start; index < marks.length; index += 1) {
    const mark = marks[index]
    if (mark.label.charCodeAt(0) !== expectedCode) break

    const endsAt = marks[index + 1]?.at ?? head.length
    const body = head.slice(mark.textFrom, endsAt).trim()

    
    
    if (body.length === 0 || body.length > MAX_OPTION_TEXT) break

    run.push({ label: mark.label, text: normalizeMath(body) })
    expectedCode += 1
  }

  if (run.length < minimum) return null

  
  
  
  if (need !== null && run.length !== need) return null

  return run
}
