import { timingSafeEqual } from 'node:crypto'

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export type CronAuth = { ok: true } | { ok: false; status: 401 | 403; message: string }

export function authenticateCron(request: Request): CronAuth {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    return { ok: false, status: 403, message: 'CRON_SECRET is not configured.' }
  }

  const header = request.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''

  if (!token || !safeEquals(token, expected)) {
    return { ok: false, status: 401, message: 'Bad cron credential.' }
  }

  return { ok: true }
}

export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  if (forwarded) return forwarded
  return headers.get('x-real-ip')?.trim() || null
}

export function callerIp(headers: Headers): string {
  return clientIp(headers) ?? 'unknown'
}

export function appBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  return stripTrailingSlashes(raw)
}

export function stripTrailingSlashes(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

export const POLICY_UPDATED = '18 August 2026'

export function contactEmail(): string | null {
  return process.env.CONTACT_EMAIL?.trim() || null
}
