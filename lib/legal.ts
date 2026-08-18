/*
 * The policy pages need one address a reader can write to and one date they
 * can check. Both live here so the two pages cannot drift apart, and so the
 * address is a deployment setting rather than something baked into the prose.
 */
export const POLICY_UPDATED = '18 August 2026'

export function contactEmail(): string {
  const explicit = process.env.CONTACT_EMAIL?.trim()
  if (explicit) return explicit

  const admin = process.env.ADMIN_EMAILS?.split(',')[0]?.trim()

  return admin || 'the address in the repository README'
}
