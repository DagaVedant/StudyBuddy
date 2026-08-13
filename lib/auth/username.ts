export const MIN_USERNAME_LENGTH = 3
export const MAX_USERNAME_LENGTH = 20

/**
 * Letters, digits and underscores, starting with a letter. No dots or
 * hyphens: this is a handle shown on a profile page, not an email local part
 * or a URL slug, and the narrower alphabet is one less way to make one that
 * reads as somebody else's with a character swapped.
 */
const USERNAME_SHAPE = /^[a-z][a-z0-9_]*$/

export type UsernameCheck =
  | { ok: true; username: string }
  | { ok: false; reason: string }

/**
 * The one place a username's rules live, so a route validating input and a
 * test asserting behaviour cannot drift apart the way `looksUnrendered`'s
 * two copies of a maths regex once did.
 *
 * Normalizes to lowercase on the way out, matching how `email` is already
 * normalized at signup: storage and the uniqueness check both work off the
 * same case, so "Dag" and "dag" are the same username without a
 * case-insensitive index.
 */
export function validateUsername(input: string | null | undefined): UsernameCheck {
  const trimmed = (input ?? '').trim().toLowerCase()

  if (!trimmed) return { ok: false, reason: 'Enter a username.' }

  if (trimmed.length < MIN_USERNAME_LENGTH) {
    return { ok: false, reason: `At least ${MIN_USERNAME_LENGTH} characters.` }
  }

  if (trimmed.length > MAX_USERNAME_LENGTH) {
    return { ok: false, reason: `${MAX_USERNAME_LENGTH} characters or fewer.` }
  }

  if (!USERNAME_SHAPE.test(trimmed)) {
    return {
      ok: false,
      reason: 'Letters, numbers and underscores only, starting with a letter.',
    }
  }

  return { ok: true, username: trimmed }
}
