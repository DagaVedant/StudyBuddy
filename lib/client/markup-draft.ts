export type MarkupOutcome = 'correct' | 'unsure' | 'wrong'

export interface MarkupDraft {
  outcomes: Record<string, MarkupOutcome>
  answers: Record<string, string>
  cursor: number
}

const EMPTY: MarkupDraft = { outcomes: {}, answers: {}, cursor: 0 }

function key(worksheetId: string): string {
  return `studybuddy:markup:${worksheetId}`
}

export function readMarkupDraft(worksheetId: string): MarkupDraft {
  if (typeof window === 'undefined') return EMPTY

  try {
    const raw = window.localStorage.getItem(key(worksheetId))
    if (!raw) return EMPTY

    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return EMPTY

    const draft = parsed as Partial<MarkupDraft>

    return {
      outcomes: pickOutcomes(draft.outcomes),
      answers: pickAnswers(draft.answers),
      cursor: Number.isInteger(draft.cursor) && draft.cursor! >= 0 ? draft.cursor! : 0,
    }
  } catch {
    return EMPTY
  }
}

export function writeMarkupDraft(worksheetId: string, draft: MarkupDraft): void {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(key(worksheetId), JSON.stringify(draft))
  } catch {
  }
}

export function clearMarkupDraft(worksheetId: string): void {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.removeItem(key(worksheetId))
  } catch {
  }
}

const OUTCOMES = new Set<MarkupOutcome>(['correct', 'unsure', 'wrong'])

function pickOutcomes(value: unknown): Record<string, MarkupOutcome> {
  if (typeof value !== 'object' || value === null) return {}

  const out: Record<string, MarkupOutcome> = {}
  for (const [id, outcome] of Object.entries(value)) {
    if (typeof outcome === 'string' && OUTCOMES.has(outcome as MarkupOutcome)) {
      out[id] = outcome as MarkupOutcome
    }
  }
  return out
}

function pickAnswers(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {}

  const out: Record<string, string> = {}
  for (const [id, answer] of Object.entries(value)) {
    if (typeof answer === 'string' && answer.length <= 2000) out[id] = answer
  }
  return out
}
