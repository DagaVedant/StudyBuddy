import {safeNextPath} from '@/lib/auth/policy'

function redirectToSignIn(): void {
  if (typeof window === 'undefined') return

  const next = safeNextPath(window.location.pathname + window.location.search)
  window.location.assign(`/signin?next=${encodeURIComponent(next)}`)
}

class SessionExpiredError extends Error {
  constructor() {
    super('Your session expired. Redirecting you to sign in.')
    this.name = 'SessionExpiredError'
  }
}

export async function fetchJson(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init)

  if (response.status === 401) {
    redirectToSignIn()
    throw new SessionExpiredError()
  }

  return response
}

class CancelledError extends Error {
  constructor() {
    super('Upload cancelled.')
    this.name = 'CancelledError'
  }
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError()
}

export function untilCancelled<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  if (signal.aborted) return Promise.reject(new CancelledError())

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new CancelledError())
    signal.addEventListener('abort', onAbort, {once: true})

    const cleanup = () => signal.removeEventListener('abort', onAbort)

    work.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      },
    )
  })
}

const UNREACHABLE = /failed to fetch|networkerror|load failed|network request failed/i

export function explainOllamaFailure(cause: unknown, baseUrl: string): string {
  const message = cause instanceof Error ? cause.message : String(cause)

  if (!UNREACHABLE.test(message)) return message

  const origin = typeof window === 'undefined' ? 'this site' : window.location.origin

  return (
    `Your browser could not reach Ollama at ${baseUrl}. Either it is not ` +
    `running, or it has not been told to accept requests from ${origin}: set ` +
    `OLLAMA_ORIGINS to ${origin} and restart Ollama. Settings has the exact ` +
    `command and a connection test.`
  )
}

export type MarkupOutcome = 'correct' | 'unsure' | 'wrong'

export interface MarkupDraft {
  outcomes: Record<string, MarkupOutcome>
  answers: Record<string, string>
  cursor: number
}

const EMPTY: MarkupDraft = {outcomes: {}, answers: {}, cursor: 0}

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
      cursor: pickCursor(draft.cursor),
    }
  } catch {
    return EMPTY
  }
}

export function writeMarkupDraft(worksheetId: string, draft: MarkupDraft): void {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(key(worksheetId), JSON.stringify(draft))
  } catch {}
}

export function clearMarkupDraft(worksheetId: string): void {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.removeItem(key(worksheetId))
  } catch {}
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

function pickCursor(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}
