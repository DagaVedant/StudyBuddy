/*
 * The policy pages need one address a reader can write to and one date they
 * can check. Both live here so the two pages cannot drift apart.
 *
 * There is deliberately no fallback to ADMIN_EMAILS. That would publish a
 * personal address on a public page because nobody set a variable, which is
 * not a decision a default should make.
 */
export const POLICY_UPDATED = '18 August 2026'

export function contactEmail(): string | null {
  return process.env.CONTACT_EMAIL?.trim() || null
}
