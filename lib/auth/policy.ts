export const MIN_AGE_YEARS = 13

export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false
  return adminEmails().includes(email.toLowerCase())
}

export function ageInYears(dob: Date, now: Date = new Date()): number {
  let age = now.getUTCFullYear() - dob.getUTCFullYear()
  const monthDelta = now.getUTCMonth() - dob.getUTCMonth()
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dob.getUTCDate())) {
    age -= 1
  }
  return age
}

export function meetsAgeRequirement(dob: Date, now: Date = new Date()): boolean {
  return ageInYears(dob, now) >= MIN_AGE_YEARS
}

export type AgeCheck = { ok: true; dob: Date } | { ok: false; reason: string }

/** What `<input type="date">` submits, which is what both callers forward. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function validateDob(input: string | Date | null | undefined): AgeCheck {
  if (!input) return { ok: false, reason: 'Enter your date of birth.' }

  /*
   * Parsed from an exact shape rather than by handing the string to `new Date`.
   *
   * V8's fallback parser is lenient enough to read a year out of prose:
   * `new Date('sometime in 2010')` is the first of January 2010, and it is
   * local midnight rather than UTC. That is two problems. Free text became a
   * valid date of birth, and the offset put the answer a day out either side of
   * the boundary for anyone west of UTC, which is precisely what the UTC
   * arithmetic below this exists to avoid. Both callers forward the value of a
   * `type="date"` field, so the shape is known and worth insisting on.
   */
  const dob =
    input instanceof Date
      ? input
      : ISO_DATE.test(input.trim())
        ? new Date(`${input.trim()}T00:00:00Z`)
        : new Date(Number.NaN)

  if (Number.isNaN(dob.getTime())) {
    return { ok: false, reason: 'That date of birth is not valid.' }
  }

  const now = new Date()
  if (dob > now) return { ok: false, reason: 'That date of birth is in the future.' }
  if (ageInYears(dob, now) > 120) {
    return { ok: false, reason: 'That date of birth is not valid.' }
  }
  if (!meetsAgeRequirement(dob, now)) {
    return {
      ok: false,
      reason: `You must be at least ${MIN_AGE_YEARS} to use StudyBuddy.`,
    }
  }

  return { ok: true, dob }
}
