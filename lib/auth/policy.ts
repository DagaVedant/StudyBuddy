/**
 * Account policy helpers (spec §2, §2.1).
 *
 * Kept free of DB and framework imports so they can be unit-tested and reused
 * from server actions, the auth callbacks, and API route guards alike.
 */

export const MIN_AGE_YEARS = 13

/**
 * Admin is derived from ADMIN_EMAILS at login and is never settable through
 * the UI (spec §2.1). Removing an email demotes the account on next login.
 */
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

/** Whole years elapsed, calendar-correct (no 365.25 drift). */
export function ageInYears(dob: Date, now: Date = new Date()): number {
  let age = now.getUTCFullYear() - dob.getUTCFullYear()
  const monthDelta = now.getUTCMonth() - dob.getUTCMonth()
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dob.getUTCDate())) {
    age -= 1
  }
  return age
}

/** The 13+ gate that keeps us out of COPPA entirely (spec §2). */
export function meetsAgeRequirement(dob: Date, now: Date = new Date()): boolean {
  return ageInYears(dob, now) >= MIN_AGE_YEARS
}

export type AgeCheck = { ok: true; dob: Date } | { ok: false; reason: string }

export function validateDob(input: string | Date | null | undefined): AgeCheck {
  if (!input) return { ok: false, reason: 'Enter your date of birth.' }

  const dob = input instanceof Date ? input : new Date(input)
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
