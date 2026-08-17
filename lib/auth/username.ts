export const MIN_USERNAME_LENGTH = 3
export const MAX_USERNAME_LENGTH = 20

const USERNAME_SHAPE = /^[a-z][a-z0-9_]*$/

export type UsernameCheck =
  | { ok: true; username: string }
  | { ok: false; reason: string }

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
