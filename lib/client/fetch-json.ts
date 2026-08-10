import { DEFAULT_AFTER_SIGNIN, safeNextPath } from '@/lib/auth/redirect'

/**
 * Where an expired session should come back to.
 *
 * Read from the live location rather than passed in, so every caller sends the
 * student back to the screen they were actually on.
 */
function currentPath(): string {
  if (typeof window === 'undefined') return DEFAULT_AFTER_SIGNIN
  return safeNextPath(window.location.pathname + window.location.search)
}

/**
 * Sends the browser to sign in, remembering where it was.
 *
 * `assign` rather than `replace`: the half-finished screen stays in history, so
 * Back after signing in does something sensible if the redirect misses.
 */
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

/**
 * `fetch`, with the one response every caller was ignoring.
 *
 * A session that expires mid-markup used to surface as "Could not save" with no
 * way forward: every 401 was handled as though it were a server fault, so the
 * student sat on a screen whose saves would never work again, with their
 * answers still in it. Nine call sites, none of which looked at 401.
 *
 * On 401 this navigates to `/signin?next=<where they were>` and throws, so the
 * caller's `catch` runs but its error branch is on screen for a moment at most.
 * Everything else is handed back untouched: this is not a wrapper that decides
 * what a 404 or a 500 means, because those differ per caller.
 */
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
