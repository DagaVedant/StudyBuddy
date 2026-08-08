import { sql } from 'drizzle-orm'

import { unwrapDriverRows } from '@/lib/db/rows'
import type { Db } from '@/lib/db/types'

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

  // Wrapped because this runs before anything else the endpoint does, so a
  // limiter that throws does not throttle a request, it removes the feature.
  // That is exactly what happened once: the table had not been migrated onto
  // the deployed database, and every upload returned a 500 having never
  // reached a line of upload code.
  //
  // Failing open is the right side to fail on. The worst case is that abuse
  // goes uncounted for as long as the table is unhappy; the alternative is
  // that every student is locked out by a bug in the thing meant to protect
  // them.
  let rows: unknown
  try {
    rows = await runCounter(db, key, nowIso, rule.windowSeconds)
  } catch (error) {
    console.error('[rate-limit] counter failed, allowing the request:', error)
    return { ok: true, remaining: rule.limit, retryAfter: 0 }
  }

  return decide(rows, rule, now)
}

async function runCounter(
  db: Db,
  key: string,
  nowIso: string,
  windowSeconds: number,
): Promise<unknown> {
  return db.execute(sql`
    INSERT INTO rate_limits (key, count, window_start)
    VALUES (${key}, 1, ${nowIso}::timestamptz)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE
        WHEN rate_limits.window_start
             <= ${nowIso}::timestamptz - make_interval(secs => ${windowSeconds})
        THEN 1
        ELSE rate_limits.count + 1
      END,
      window_start = CASE
        WHEN rate_limits.window_start
             <= ${nowIso}::timestamptz - make_interval(secs => ${windowSeconds})
        THEN ${nowIso}::timestamptz
        ELSE rate_limits.window_start
      END
    RETURNING count, window_start
  `)
}

function decide(rows: unknown, rule: LimitRule, now: Date): LimitDecision {
  const first = unwrapDriverRows<{ count: number | string; window_start: string | Date }>(rows)[0]

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

// Re-exported so the rate-limit call sites keep reading as one import. The
// header parsing itself lives in lib/http/client-ip.ts, shared with the worker
// auth, which used to keep its own copy.
export { callerIp } from '@/lib/http/client-ip'
