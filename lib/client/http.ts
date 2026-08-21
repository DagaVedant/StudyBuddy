import { DEFAULT_AFTER_SIGNIN, safeNextPath } from '@/lib/auth/policy'

function currentPath(): string {
  if (typeof window === 'undefined') return DEFAULT_AFTER_SIGNIN
  return safeNextPath(window.location.pathname + window.location.search)
}

export function redirectToSignIn(): void {
  if (typeof window === 'undefined') return
  window.location.assign(`/signin?next=${encodeURIComponent(currentPath())}`)
}

export class SessionExpiredError extends Error {
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

export class CancelledError extends Error {
  constructor(message = 'Upload cancelled.') {
    super(message)
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
    signal.addEventListener('abort', onAbort, { once: true })

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
