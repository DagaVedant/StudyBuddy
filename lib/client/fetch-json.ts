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
