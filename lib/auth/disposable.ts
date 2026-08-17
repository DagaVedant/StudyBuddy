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
