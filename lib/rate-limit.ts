import { sql } from 'drizzle-orm'

import type { Db } from '@/lib/dashboard/queries'

export interface LimitDecision {
  ok: boolean
  /** Requests still allowed in this window. */
  remaining: number
  /** Seconds until the window resets. Zero when the request was allowed. */
  retryAfter: number
}

export interface LimitRule {
  /** Distinct name for the action being limited, e.g. `signup`. */
  action: string
  limit: number
  windowSeconds: number
}

/** Signing up: keyed by IP, because there is no account yet to key on. */
export const SIGNUP_LIMIT: LimitRule = { action: 'signup', limit: 5, windowSeconds: 3600 }

/** Uploading. Generous — a real student may have a stack of worksheets. */
export const UPLOAD_LIMIT: LimitRule = { action: 'upload', limit: 30, windowSeconds: 3600 }

/** Explanations, which cost a model call each. */
export const EXPLAIN_LIMIT: LimitRule = { action: 'explain', limit: 60, windowSeconds: 3600 }

export function limitKey(rule: LimitRule, subject: string): string {
  return `${rule.action}:${subject.slice(0, 180)}`
}

/**
 * Counts one request against a rule and says whether to allow it.
 *
 * Fixed windows rather than a sliding log: the failure mode is that someone
 * spends a full window's allowance either side of a boundary, which for signup
 * and upload limits is a rounding error, and it costs one row and one
 * statement instead of a row per request.
 *
 * The whole decision is a single upsert so that two concurrent requests cannot
 * both read the same count and both decide they are under the limit.
 */
/**
 * Whether limits are enforced at all.
 *
 * The end-to-end suite signs up many times from one address, which is exactly
 * the shape the signup limit exists to stop, so it would throttle the tests
 * long before it throttled an abuser. Off only when explicitly asked, so a
 * deployment cannot end up unprotected by omission.
 */
export function limitsEnforced(): boolean {
  return process.env.DISABLE_RATE_LIMITS !== 'true'
}

export async function consumeRateLimit(
  db: Db,
  rule: LimitRule,
  subject: string,
  now: Date = new Date(),
): Promise<LimitDecision> {
  if (!limitsEnforced()) return { ok: true, remaining: rule.limit, retryAfter: 0 }

  const key = limitKey(rule, subject)

  // Passed as an ISO string: the driver renders a Date into a form Postgres
  // rejects here.
  const nowIso = now.toISOString()

  const rows = await db.execute(sql`
    INSERT INTO rate_limits (key, count, window_start)
    VALUES (${key}, 1, ${nowIso}::timestamptz)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE
        WHEN rate_limits.window_start
             <= ${nowIso}::timestamptz - make_interval(secs => ${rule.windowSeconds})
        THEN 1
        ELSE rate_limits.count + 1
      END,
      window_start = CASE
        WHEN rate_limits.window_start
             <= ${nowIso}::timestamptz - make_interval(secs => ${rule.windowSeconds})
        THEN ${nowIso}::timestamptz
        ELSE rate_limits.window_start
      END
    RETURNING count, window_start
  `)

  const row = (rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown as unknown[])
  const first = (Array.isArray(row) ? row[0] : undefined) as
    | { count: number | string; window_start: string | Date }
    | undefined

  // No row back means the statement did not behave as expected. Allowing the
  // request is the right call: a broken limiter must not lock everyone out.
  if (!first) return { ok: true, remaining: rule.limit, retryAfter: 0 }

  const count = Number(first.count)
  const windowStart = new Date(first.window_start)
  const resetsAt = windowStart.getTime() + rule.windowSeconds * 1000

  if (count > rule.limit) {
    return {
      ok: false,
      remaining: 0,
      retryAfter: Math.max(1, Math.ceil((resetsAt - now.getTime()) / 1000)),
    }
  }

  return { ok: true, remaining: Math.max(0, rule.limit - count), retryAfter: 0 }
}

/**
 * Best-effort caller IP.
 *
 * Behind Vercel the left-most x-forwarded-for entry is the client. Falls back
 * to a constant so a missing header degrades to one shared bucket rather than
 * to no limit at all — noisy for the rare visitor with no header, but the
 * alternative is a header that trivially disables the limiter.
 */
export function callerIp(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for')
  const first = forwarded?.split(',')[0]?.trim()
  return first || headers.get('x-real-ip')?.trim() || 'unknown'
}
