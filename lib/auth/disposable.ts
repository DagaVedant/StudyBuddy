/**
 * Domains that hand out a fresh inbox to anyone who asks.
 *
 * Of the four Sybil defences spec.md:582 describes, this is the one that is
 * worth its weight. Email verification is not coming back: nothing in this
 * codebase sends mail, and putting a delivery failure between a student and
 * their account costs more than it prevents. The per-IP signup limit fails open
 * by design, because a rate limiter that locks out a whole school when its
 * counter errors is worse than one that lets a few through. That leaves this.
 *
 * It is a blocklist, so it is permanently incomplete, and that is fine. The
 * prize for getting past it is three worksheets. The point is to stop the
 * thirty-second version, where one person opens a throwaway inbox site and
 * mints trial accounts in a loop, not to be unbeatable.
 *
 * Matched on the registrable suffix, so `mail.10minutemail.com` is caught by
 * the `10minutemail.com` entry without needing its own line.
 */
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

/**
 * Whether an address belongs to a domain that exists to be thrown away.
 *
 * Returns false for anything it cannot read as an address. Rejecting on a
 * malformed address is the schema's job, and doing it here too would report the
 * wrong reason to whoever typed it.
 */
export function isDisposableEmail(email: string): boolean {
  const domain = email.trim().toLowerCase().split('@')[1]
  if (!domain) return false

  // Every suffix, not just the whole domain, so a subdomain of a listed host is
  // caught too. `a.b.mailinator.com` tries `a.b.mailinator.com`, then
  // `b.mailinator.com`, then `mailinator.com`, which hits.
  const labels = domain.split('.')
  for (let i = 0; i < labels.length - 1; i += 1) {
    if (DISPOSABLE_DOMAINS.has(labels.slice(i).join('.'))) return true
  }

  return false
}
