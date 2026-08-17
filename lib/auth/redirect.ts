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
