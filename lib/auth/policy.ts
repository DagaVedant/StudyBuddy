

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

export type AgeCheck = {ok: true; dob: Date} | {ok: false; reason: string}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function validateDob(input: string | Date | null | undefined): AgeCheck {
  if (!input) return {ok: false, reason: 'Enter your date of birth.'}

  const dob =
    input instanceof Date
      ? input
      : ISO_DATE.test(input.trim())
        ? new Date(`${input.trim()}T00:00:00Z`)
        : new Date(Number.NaN)

  if (Number.isNaN(dob.getTime())) {
    return {ok: false, reason: 'That date of birth is not valid.'}
  }

  const now = new Date()
  if (dob > now) return {ok: false, reason: 'That date of birth is in the future.'}
  if (ageInYears(dob, now) > 120) {
    return {ok: false, reason: 'That date of birth is not valid.'}
  }
  if (!meetsAgeRequirement(dob, now)) {
    return {
      ok: false,
      reason: `You must be at least ${MIN_AGE_YEARS} to use StudyBuddy.`,
    }
  }

  return {ok: true, dob}
}

export const DEFAULT_AFTER_SIGNIN = '/dashboard'

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export function safeNextPath(
  value: unknown,
  fallback: string = DEFAULT_AFTER_SIGNIN,
): string {
  if (typeof value !== 'string') return fallback

  const next = value.trim()

  if (!next.startsWith('/')) return fallback
  if (next.startsWith('//') || next.startsWith('/\\')) return fallback
  if (next.includes('\\')) return fallback
  if (CONTROL_CHARS.test(next)) return fallback

  try {
    const probe = new URL(next, 'https://studybuddy.invalid')
    if (probe.origin !== 'https://studybuddy.invalid') return fallback
    return probe.pathname + probe.search + probe.hash
  } catch {
    return fallback
  }
}

const DISPOSABLE_DOMAINS = new Set([
  '0-mail.com',
  '10minutemail.com',
  '20minutemail.com',
  '33mail.com',
  'anonaddy.com',
  'anonaddy.me',
  'burnermail.io',
  'cock.li',
  'dispostable.com',
  'duck.com',
  'emailondeck.com',
  'fakeinbox.com',
  'fakemailgenerator.com',
  'getairmail.com',
  'getnada.com',
  'grr.la',
  'guerrillamail.biz',
  'guerrillamail.com',
  'guerrillamail.de',
  'guerrillamail.info',
  'guerrillamail.net',
  'guerrillamail.org',
  'guerrillamailblock.com',
  'inboxbear.com',
  'inboxkitten.com',
  'jetable.org',
  'mailcatch.com',
  'maildrop.cc',
  'mailinator.com',
  'mailnesia.com',
  'mailsac.com',
  'mailtemp.net',
  'mintemail.com',
  'moakt.com',
  'mohmal.com',
  'mytemp.email',
  'nowmymail.com',
  'pokemail.net',
  'sharklasers.com',
  'simplelogin.io',
  'spam4.me',
  'spambog.com',
  'spamgourmet.com',
  'temp-mail.io',
  'temp-mail.org',
  'tempail.com',
  'tempinbox.com',
  'tempmail.dev',
  'tempmail.plus',
  'tempmailo.com',
  'tempr.email',
  'throwawaymail.com',
  'trashmail.com',
  'trashmail.de',
  'trashmail.me',
  'trbvm.com',
  'yopmail.com',
  'yopmail.fr',
  'yopmail.net',
])

export function isDisposableEmail(email: string): boolean {
  const domain = email.trim().toLowerCase().split('@')[1]
  if (!domain) return false

  const labels = domain.split('.')
  for (let i = 0; i < labels.length - 1; i += 1) {
    if (DISPOSABLE_DOMAINS.has(labels.slice(i).join('.'))) return true
  }

  return false
}
