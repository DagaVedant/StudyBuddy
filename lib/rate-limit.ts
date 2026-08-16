import { sql } from 'drizzle-orm'

import { unwrapDriverRows } from '@/lib/db/rows'
import type { Db } from '@/lib/db/types'

export interface LimitDecision {
  ok: boolean
  /** Requests still allowed in this window. */
  remaining: number
  /** Seconds until the window resets. Zero when the request was allowed. */
  retryAfter: number
  /**
   * Why a request was refused, for call sites that put it in front of a person.
   *
   * `limited` is the allowance being spent, which is the caller's own doing.
   * `unavailable` is the counter being unreadable, which is ours: telling a
   * first-time student "too many sign-up attempts from this connection" when
   * they have made none is a lie about them to cover a database problem.
   */
  reason?: 'limited' | 'unavailable'
}

export interface LimitRule {
  /** Distinct name for the action being limited, e.g. `signup`. */
  action: string
  limit: number
  windowSeconds: number
  /**
   * Refuse the request when the counter itself cannot be read.
   *
   * Off for every rule but one, and the default is the argued position: a
   * limiter that throws does not throttle a request, it removes the feature,
   * and the worst case of failing open is that abuse goes uncounted while the
   * table is unhappy. Locking every student out of their own work because the
   * thing protecting them has a bug is the worse outcome.
   *
   * That argument is about rules guarding a student's own actions, and finding
   * 67 wrote down the condition for revisiting it: "if the limiter ever guards
   * something whose abuse costs more than a lockout would". See SIGNUP_LIMIT.
   */
  failClosed?: boolean
}

/**
 * Signing up: keyed by IP, because there is no account yet to key on.
 *
 * The one rule that fails closed, and the one that meets finding 67's own
 * condition for it. Every account created is three worksheets of real
 * extraction on the operator's GPU, spent before anything is verified, so an
 * unbounded signup endpoint is an unbounded claim on somebody's electricity
 * bill: finding 114 called this the Sybil defence, and a defence that switches
 * itself off when the database is unhappy is not one.
 *
 * What failing closed costs is bounded in a way the others are not. Nobody
 * loses access to work they have already done, no session breaks, and nothing a
 * student is in the middle of stops: signing up is refused for as long as the
 * counter is unreadable, which is a broken deployment somebody is already being
 * paged about. Signing in is deliberately not in this club, because locking out
 * every existing student is exactly the outcome failing open exists to prevent.
 */
export const SIGNUP_LIMIT: LimitRule = {
  action: 'signup',
  limit: 5,
  windowSeconds: 3600,
  failClosed: true,
}

/**
 * Signing in. Counted twice, once per IP and once per submitted address.
 *
 * Authentication was the one action with no rule at all, so password guessing
 * was unthrottled. It is also the most expensive thing an anonymous caller can
 * ask for: `bcryptjs` is the pure-JS build at cost 12, so every attempt buys a
 * large block of single-threaded server CPU whether the password is right or
 * not. A guessing loop is a denial of service against everyone else before it
 * is ever a break-in.
 *
 * Both keys, because either alone leaves a hole. Per IP only lets a botnet
 * spread one account's guesses across a thousand addresses. Per email only lets
 * anyone lock a student out of their own account by guessing at it, which is
 * why the per-email allowance is the looser of the two.
 *
 * Twenty an hour is far past a person mistyping their own password and far
 * short of useful for guessing.
 */
export const SIGNIN_IP_LIMIT: LimitRule = {
  action: 'signin-ip',
  limit: 20,
  windowSeconds: 3600,
}

export const SIGNIN_EMAIL_LIMIT: LimitRule = {
  action: 'signin-email',
  limit: 30,
  windowSeconds: 3600,
}

/** Uploading. Generous: a real student may have a stack of worksheets. */
export const UPLOAD_LIMIT: LimitRule = { action: 'upload', limit: 30, windowSeconds: 3600 }

/**
 * Page images, which is where the money actually goes.
 *
 * UPLOAD_LIMIT counts worksheets, and a worksheet is one cheap row. The
 * expensive call is this one: up to 4 MB into blob storage per page, up to 75
 * pages per worksheet, and the limiter sat on the wrong one of the two. Thirty
 * worksheets an hour was therefore also permission for 2,250 blob writes.
 *
 * 400 an hour is more than five full 75-page worksheets, which is far past what
 * a student does in an afternoon, and it bounds the worst hour at about 1.6 GB
 * rather than 9 GB. Keyed by account rather than IP, like the worksheet limit,
 * so a shared school connection is not one student away from being locked out.
 */
export const PAGE_UPLOAD_LIMIT: LimitRule = {
  action: 'page-upload',
  limit: 400,
  windowSeconds: 3600,
}

/** Explanations, which cost a model call each. */
export const EXPLAIN_LIMIT: LimitRule = { action: 'explain', limit: 60, windowSeconds: 3600 }

/**
 * Reporting something as wrong. Loose enough that a student working through a
 * badly read worksheet can flag every question on it, tight enough that the
 * admin queue cannot be filled by one account in a loop.
 */
export const REPORT_LIMIT: LimitRule = { action: 'report', limit: 40, windowSeconds: 3600 }

/**
 * Adding questions by hand, which is the one route that creates rows without
 * an upload behind it.
 *
 * Generous against real use and still a bound. A student boxing every question
 * on a long paper themselves is the heaviest honest case and it is one request
 * per question, so a 114-question paper drawn entirely by hand fits inside
 * this twice over. What it stops is a loop: the endpoint took a JSON body and
 * wrote a row, unbounded, on an account that costs nothing to make.
 */
export const QUESTION_WRITE_LIMIT: LimitRule = {
  action: 'question-write',
  limit: 300,
  windowSeconds: 3600,
}

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
    if (rule.failClosed) {
      console.error(`[rate-limit] counter failed, refusing ${rule.action}:`, error)
      return unreadable(rule)
    }

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

/**
 * What a `failClosed` rule answers when it cannot count.
 *
 * A short retry rather than the window's own length. The window is an hour
 * because that is how long an allowance should last, and this is not an
 * allowance being spent: it is the counter being unreadable, which is a
 * transient state somebody is fixing. Telling an honest new student to come
 * back in an hour for a database blip they had nothing to do with would be its
 * own kind of dishonest.
 */
function unreadable(rule: LimitRule): LimitDecision {
  return {
    ok: false,
    remaining: 0,
    retryAfter: Math.min(60, rule.windowSeconds),
    reason: 'unavailable',
  }
}

function decide(rows: unknown, rule: LimitRule, now: Date): LimitDecision {
  const first = unwrapDriverRows<{ count: number | string; window_start: string | Date }>(rows)[0]

  // No row back means the statement did not behave as expected, which is the
  // same state as a throw and takes the same side: allowing keeps a broken
  // limiter from locking everyone out, except where the rule says the abuse
  // costs more than the lockout does.
  if (!first) return rule.failClosed ? unreadable(rule) : { ok: true, remaining: rule.limit, retryAfter: 0 }

  const count = Number(first.count)
  const windowStart = new Date(first.window_start)
  const resetsAt = windowStart.getTime() + rule.windowSeconds * 1000

  if (count > rule.limit) {
    return {
      ok: false,
      remaining: 0,
      retryAfter: Math.max(1, Math.ceil((resetsAt - now.getTime()) / 1000)),
      reason: 'limited',
    }
  }

  return { ok: true, remaining: Math.max(0, rule.limit - count), retryAfter: 0 }
}

// Re-exported so the rate-limit call sites keep reading as one import. The
// header parsing itself lives in lib/http/client-ip.ts, shared with the worker
// auth, which used to keep its own copy.
export { callerIp } from '@/lib/http/client-ip'
