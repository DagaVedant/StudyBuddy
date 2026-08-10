/** Where sign-in sends anyone whose `next` cannot be trusted. */
export const DEFAULT_AFTER_SIGNIN = '/dashboard'

/** Control characters, which have no business in a Location header. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/**
 * Reduces a `next` parameter to a path on this site, or to the default.
 *
 * `signInWithCredentials` passed the raw form field straight to `redirectTo`,
 * so `/signin?next=https://example.com` sent the student to example.com the
 * moment they authenticated. That is the classic open redirect, and sign-in is
 * the worst place to have one: the victim arrives at the attacker's page having
 * just been asked for a password, ready to be asked again.
 *
 * A leading slash is the whole test, and it has to be exactly one.
 * `//example.com` is a protocol-relative URL that browsers read as a host,
 * which is the case a naive `startsWith('/')` waves through. `/\example.com` is
 * the same trick with a backslash, which some browsers normalise into a slash.
 *
 * The query and fragment survive, because `?tab=topics` is a real thing to come
 * back to. Anything carrying a scheme, a host, a backslash or a control
 * character is discarded rather than repaired: a `next` this cannot read is not
 * worth guessing at.
 */
export function safeNextPath(
  value: unknown,
  fallback: string = DEFAULT_AFTER_SIGNIN,
): string {
  if (typeof value !== 'string') return fallback

  const next = value.trim()

  if (!next.startsWith('/')) return fallback
  // Protocol-relative, in either slash direction.
  if (next.startsWith('//') || next.startsWith('/\\')) return fallback
  // A backslash anywhere is not something this app produces, and it is how
  // several parser-confusion tricks are spelled.
  if (next.includes('\\')) return fallback
  // A stray CR or LF is how header splitting is spelled.
  if (CONTROL_CHARS.test(next)) return fallback

  // Checked against the parser rather than only against rules: resolved from an
  // arbitrary origin, a genuinely relative path stays on that origin.
  try {
    const probe = new URL(next, 'https://studybuddy.invalid')
    if (probe.origin !== 'https://studybuddy.invalid') return fallback
    return probe.pathname + probe.search + probe.hash
  } catch {
    return fallback
  }
}
