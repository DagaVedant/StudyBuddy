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

/**
 * Marking a paper, kept on the device until it is posted.
 *
 * The markup screen writes nothing until every question has been marked, so a
 * 114-question paper is 114 decisions held in React state and lost to a reload,
 * a crash, a phone deciding to reclaim the tab, or a mistaken back gesture.
 * That is the whole of somebody's session.
 *
 * A local draft rather than posting each mark as it is made. Marking is once
 * per paper by construction: `attempts_markup_once` is a unique index and the
 * route answers a repeat post with 409, deliberately, so that a tab left open
 * cannot write a second set of answers. Half a paper posted early would be a
 * paper that can never be finished. So the marks stay here until they are
 * complete, and this is what stops them being lost in the meantime.
 *
 * Every read is defensive. This is user-writable storage that survives
 * deploys, so a draft written by an older version of this screen, or by
 * somebody with a console open, has to be treated as suspect rather than
 * spread into component state.
 */
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
    // A quota error, a disabled store, or unparseable content. None of those
    // are worth failing the screen over: the cost is a draft, not the marks.
    return EMPTY
  }
}

export function writeMarkupDraft(worksheetId: string, draft: MarkupDraft): void {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(key(worksheetId), JSON.stringify(draft))
  } catch {
    // Private browsing and a full quota both land here. The screen keeps
    // working; it just stops being crash-proof.
  }
}

export function clearMarkupDraft(worksheetId: string): void {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.removeItem(key(worksheetId))
  } catch {
    // Nothing to do about it, and nothing depends on it: a stale draft is
    // discarded on the next load anyway, because the worksheet is marked.
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
    // Bounded, because this is read back into a form field and posted. A free
    // text answer is a few characters; anything of length is not one.
    if (typeof answer === 'string' && answer.length <= 2000) out[id] = answer
  }
  return out
}
