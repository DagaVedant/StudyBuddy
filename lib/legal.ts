export const POLICY_UPDATED = '18 August 2026'

export function contactEmail(): string | null {
  return process.env.CONTACT_EMAIL?.trim() || null
}
