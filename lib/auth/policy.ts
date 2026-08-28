export const MIN_AGE_YEARS = 13

function adminEmails() {
  let raw = process.env.ADMIN_EMAILS
  if (!raw) raw = ''

  const emails: string[] = []

  for (const value of raw.split(',')) {
    const email = value.trim().toLowerCase()
    if (email) emails.push(email)
  }

  return emails
}

export function isAdminEmail(email: string | null | undefined) {
  if (!email) return false

  return adminEmails().includes(email.toLowerCase())
}

function ageInYears(dob: Date, now: Date = new Date()) {
  let age = now.getUTCFullYear() - dob.getUTCFullYear()

  const monthDelta = now.getUTCMonth() - dob.getUTCMonth()

  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dob.getUTCDate())) {
    age = age - 1
  }

  return age
}

export type AgeCheck = {
  ok: boolean
  dob: Date | null
  reason: string
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function validateDob(input: string | Date | null | undefined): AgeCheck {
  if (!input) return {ok: false, dob: null, reason: 'Enter your date of birth.'}

  let dob: Date

  if (input instanceof Date) {
    dob = input
  } else if (ISO_DATE.test(input.trim())) {
    dob = new Date(input.trim() + 'T00:00:00Z')
  } else {
    dob = new Date(Number.NaN)
  }

  if (Number.isNaN(dob.getTime())) {
    return {ok: false, dob: null, reason: 'That date of birth is not valid.'}
  }

  const now = new Date()

  if (dob > now) {
    return {ok: false, dob: null, reason: 'That date of birth is in the future.'}
  }

  const age = ageInYears(dob, now)

  if (age > 120) {
    return {ok: false, dob: null, reason: 'That date of birth is not valid.'}
  }

  if (age < MIN_AGE_YEARS) {
    return {
      ok: false,
      dob: null,
      reason: 'You must be at least ' + MIN_AGE_YEARS + ' to use StudyBuddy.',
    }
  }

  return {ok: true, dob: dob, reason: ''}
}

const DEFAULT_AFTER_SIGNIN = '/dashboard'

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export function safeNextPath(value: unknown, fallback: string = DEFAULT_AFTER_SIGNIN) {
  if (typeof value !== 'string') return fallback

  const next = value.trim()

  if (!next.startsWith('/')) return fallback
  if (next.startsWith('//')) return fallback
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
  '0-mail.com', '10minutemail.com', '20minutemail.com', '33mail.com', 'anonaddy.com',
  'anonaddy.me', 'burnermail.io', 'cock.li', 'dispostable.com', 'duck.com',
  'emailondeck.com', 'fakeinbox.com', 'fakemailgenerator.com', 'getairmail.com',
  'getnada.com', 'grr.la', 'guerrillamail.biz', 'guerrillamail.com', 'guerrillamail.de',
  'guerrillamail.info', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamailblock.com',
  'inboxbear.com', 'inboxkitten.com', 'jetable.org', 'mailcatch.com', 'maildrop.cc',
  'mailinator.com', 'mailnesia.com', 'mailsac.com', 'mailtemp.net', 'mintemail.com',
  'moakt.com', 'mohmal.com', 'mytemp.email', 'nowmymail.com', 'pokemail.net',
  'sharklasers.com', 'simplelogin.io', 'spam4.me', 'spambog.com', 'spamgourmet.com',
  'temp-mail.io', 'temp-mail.org', 'tempail.com', 'tempinbox.com', 'tempmail.dev',
  'tempmail.plus', 'tempmailo.com', 'tempr.email', 'throwawaymail.com', 'trashmail.com',
  'trashmail.de', 'trashmail.me', 'trbvm.com', 'yopmail.com', 'yopmail.fr', 'yopmail.net',
])

export function isDisposableEmail(email: string) {
  const domain = email.trim().toLowerCase().split('@')[1]
  if (!domain) return false

  const labels = domain.split('.')

  for (let i = 0; i < labels.length - 1; i++) {
    if (DISPOSABLE_DOMAINS.has(labels.slice(i).join('.'))) return true
  }

  return false
}

const DOTLESS_DOMAINS = new Set(['gmail.com', 'googlemail.com'])

export function canonicalEmail(email: string) {
  const cleaned = email.trim().toLowerCase()
  const parts = cleaned.split('@')

  const rawLocal = parts[0]
  let domain = parts[1]

  if (!domain) return cleaned

  let local = rawLocal.split('+')[0]
  if (DOTLESS_DOMAINS.has(domain)) local = local.replace(/\./g, '')

  if (domain === 'googlemail.com') domain = 'gmail.com'

  return local + '@' + domain
}
