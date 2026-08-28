import {safeNextPath} from '@/lib/auth/policy'

function redirectToSignIn() {
  if (typeof window === 'undefined') return

  const next = safeNextPath(window.location.pathname + window.location.search)
  window.location.assign('/signin?next=' + encodeURIComponent(next))
}

function sessionExpired() {
  const error = new Error('Your session expired. Redirecting you to sign in.')
  error.name = 'SessionExpiredError'
  return error
}

function cancelled() {
  const error = new Error('Upload cancelled.')
  error.name = 'CancelledError'
  return error
}

export async function fetchJson(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetch(input, init)

  if (response.status === 401) {
    redirectToSignIn()
    throw sessionExpired()
  }

  return response
}

export function throwIfCancelled(signal?: AbortSignal) {
  if (signal && signal.aborted) throw cancelled()
}

export function untilCancelled<T>(work: Promise<T>, signal?: AbortSignal) {
  if (!signal) return work
  if (signal.aborted) return Promise.reject(cancelled())

  return new Promise<T>((resolve, reject) => {
    function onAbort() {
      reject(cancelled())
    }

    signal.addEventListener('abort', onAbort, {once: true})

    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

export function explainOllamaFailure(cause: unknown, baseUrl: string) {
  let message = String(cause)
  if (cause instanceof Error) message = cause.message

  if (!/failed to fetch|networkerror|load failed|network request failed/i.test(message)) {
    return message
  }

  let origin = 'this site'
  if (typeof window !== 'undefined') origin = window.location.origin

  return (
    'Your browser could not reach Ollama at ' +
    baseUrl +
    '. Either it is not running, or it has not been told to accept requests from ' +
    origin +
    ': set OLLAMA_ORIGINS to ' +
    origin +
    ' and restart Ollama. Settings has the exact command and a connection test.'
  )
}

export type MarkupOutcome = 'correct' | 'unsure' | 'wrong'

export type MarkupDraft = {
  outcomes: {[id: string]: MarkupOutcome}
  answers: {[id: string]: string}
  cursor: number
}

function emptyDraft(): MarkupDraft {
  return {outcomes: {}, answers: {}, cursor: 0}
}

function key(worksheetId: string) {
  return 'studybuddy:markup:' + worksheetId
}

function pickOutcomes(value: unknown) {
  let out: {[id: string]: MarkupOutcome} = {}
  if (typeof value !== 'object' || value === null) return out

  let source = value as {[id: string]: unknown}

  for (let id of Object.keys(source)) {
    let outcome = source[id]

    if (outcome === 'correct' || outcome === 'unsure' || outcome === 'wrong') {
      out[id] = outcome
    }
  }

  return out
}

function pickAnswers(value: unknown) {
  let out: {[id: string]: string} = {}
  if (typeof value !== 'object' || value === null) return out

  let source = value as {[id: string]: unknown}

  for (let id of Object.keys(source)) {
    let answer = source[id]
    if (typeof answer === 'string' && answer.length <= 2000) out[id] = answer
  }

  return out
}

function pickCursor(value: unknown) {
  if (typeof value !== 'number') return 0
  if (!Number.isInteger(value)) return 0
  if (value < 0) return 0
  return value
}

export function readMarkupDraft(worksheetId: string) {
  if (typeof window === 'undefined') return emptyDraft()

  try {
    const raw = window.localStorage.getItem(key(worksheetId))
    if (!raw) return emptyDraft()

    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return emptyDraft()

    const draft = parsed as Partial<MarkupDraft>

    return {
      outcomes: pickOutcomes(draft.outcomes),
      answers: pickAnswers(draft.answers),
      cursor: pickCursor(draft.cursor),
    }
  } catch {
    return emptyDraft()
  }
}

export function writeMarkupDraft(worksheetId: string, draft: MarkupDraft) {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(key(worksheetId), JSON.stringify(draft))
  } catch {}
}

export function clearMarkupDraft(worksheetId: string) {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.removeItem(key(worksheetId))
  } catch {}
}
