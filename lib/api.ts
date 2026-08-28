import {timingSafeEqual} from 'node:crypto'

import {sql} from 'drizzle-orm'

import {type Db, unwrapDriverRows} from '@/lib/db'

export type LimitDecision = {
  ok: boolean
  remaining: number
  retryAfter: number
  reason: string
}

export type LimitRule = {
  action: string
  limit: number
  windowSeconds: number
  failClosed?: boolean
}

export const SIGNUP_LIMIT: LimitRule = {
  action: 'signup',
  limit: 5,
  windowSeconds: 3600,
  failClosed: true,
}

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

export const RESET_REQUEST_IP_LIMIT: LimitRule = {
  action: 'reset-request-ip',
  limit: 10,
  windowSeconds: 3600,
  failClosed: true,
}

export const RESET_REQUEST_EMAIL_LIMIT: LimitRule = {
  action: 'reset-request-email',
  limit: 5,
  windowSeconds: 3600,
  failClosed: true,
}

export const RESET_ATTEMPT_LIMIT: LimitRule = {
  action: 'reset-attempt',
  limit: 20,
  windowSeconds: 3600,
  failClosed: true,
}

export const UPLOAD_LIMIT: LimitRule = {action: 'upload', limit: 30, windowSeconds: 3600}

export const PAGE_UPLOAD_LIMIT: LimitRule = {
  action: 'page-upload',
  limit: 400,
  windowSeconds: 3600,
}

export const EXPLAIN_LIMIT: LimitRule = {action: 'explain', limit: 60, windowSeconds: 3600}

export const REPORT_LIMIT: LimitRule = {action: 'report', limit: 40, windowSeconds: 3600}

export const QUESTION_WRITE_LIMIT: LimitRule = {
  action: 'question-write',
  limit: 300,
  windowSeconds: 3600,
}

export const LESSON_LIMIT: LimitRule = {action: 'lesson', limit: 30, windowSeconds: 3600}

export const PRACTICE_LIMIT: LimitRule = {
  action: 'practice',
  limit: 12,
  windowSeconds: 86400,
}

export const ACCOUNT_LIMIT: LimitRule = {action: 'account', limit: 20, windowSeconds: 3600}

export const CREDENTIAL_LIMIT: LimitRule = {
  action: 'credential',
  limit: 20,
  windowSeconds: 3600,
}

export const EXPORT_LIMIT: LimitRule = {action: 'export', limit: 60, windowSeconds: 3600}

export const REVIEW_LIMIT: LimitRule = {action: 'review', limit: 600, windowSeconds: 3600}

export const WORKSHEET_WRITE_LIMIT: LimitRule = {
  action: 'worksheet-write',
  limit: 200,
  windowSeconds: 3600,
}

function limitsEnforced() {
  return process.env.DISABLE_RATE_LIMITS !== 'true'
}

function allowed(rule: LimitRule): LimitDecision {
  return {ok: true, remaining: rule.limit, retryAfter: 0, reason: ''}
}

function unreadable(rule: LimitRule): LimitDecision {
  let retryAfter = rule.windowSeconds
  if (retryAfter > 60) retryAfter = 60

  return {ok: false, remaining: 0, retryAfter: retryAfter, reason: 'unavailable'}
}

async function runCounter(db: Db, key: string, nowIso: string, windowSeconds: number) {
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
  const found = unwrapDriverRows<{count: number | string; window_start: string | Date}>(rows)
  const first = found[0]

  if (!first) {
    if (rule.failClosed) return unreadable(rule)
    return allowed(rule)
  }

  const count = Number(first.count)
  const windowStart = new Date(first.window_start)
  const resetsAt = windowStart.getTime() + rule.windowSeconds * 1000

  if (count > rule.limit) {
    let retryAfter = Math.ceil((resetsAt - now.getTime()) / 1000)
    if (retryAfter < 1) retryAfter = 1

    return {ok: false, remaining: 0, retryAfter: retryAfter, reason: 'limited'}
  }

  let remaining = rule.limit - count
  if (remaining < 0) remaining = 0

  return {ok: true, remaining: remaining, retryAfter: 0, reason: ''}
}

export async function consumeRateLimit(
  db: Db,
  rule: LimitRule,
  subject: string,
): Promise<LimitDecision> {
  if (!limitsEnforced()) return allowed(rule)

  const now = new Date()
  const key = rule.action + ':' + subject.slice(0, 180)
  const nowIso = now.toISOString()

  let rows: unknown

  try {
    rows = await runCounter(db, key, nowIso, rule.windowSeconds)
  } catch (error) {
    if (rule.failClosed) {
      console.error('[rate-limit] counter failed, refusing ' + rule.action + ':', error)
      return unreadable(rule)
    }

    console.error('[rate-limit] counter failed, allowing the request:', error)
    return allowed(rule)
  }

  return decide(rows, rule, now)
}

export async function guardRateLimit(
  db: Db,
  rule: LimitRule,
  subject: string,
  message: string,
) {
  const decision = await consumeRateLimit(db, rule, subject)
  if (decision.ok) return null

  return Response.json(
    {error: message},
    {status: 429, headers: {'Retry-After': String(decision.retryAfter)}},
  )
}

function safeEquals(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)

  if (left.length !== right.length) return false

  return timingSafeEqual(left, right)
}

export type CronAuth = {
  ok: boolean
  status: number
  message: string
}

export function authenticateCron(request: Request): CronAuth {
  const expected = process.env.CRON_SECRET

  if (!expected) {
    return {ok: false, status: 403, message: 'CRON_SECRET is not configured.'}
  }

  let header = request.headers.get('authorization')
  if (!header) header = ''

  let token = ''
  if (header.startsWith('Bearer ')) token = header.slice(7)

  if (!token || !safeEquals(token, expected)) {
    return {ok: false, status: 401, message: 'Bad cron credential.'}
  }

  return {ok: true, status: 200, message: ''}
}

export function clientIp(headers: Headers) {
  const forwarded = headers.get('x-forwarded-for')

  if (forwarded) {
    const first = forwarded.split(',')[0].trim()
    if (first) return first
  }

  const real = headers.get('x-real-ip')
  if (real && real.trim()) return real.trim()

  return null
}

export function callerIp(headers: Headers) {
  const ip = clientIp(headers)
  if (!ip) return 'unknown'

  return ip
}

export function appBaseUrl() {
  let raw = process.env.NEXT_PUBLIC_APP_URL
  if (!raw) raw = 'http://localhost:3000'

  return raw.trim().replace(/\/+$/, '')
}

export const POLICY_UPDATED = '18 August 2026'

export function contactEmail() {
  const raw = process.env.CONTACT_EMAIL
  if (!raw || !raw.trim()) return null

  return raw.trim()
}

export async function readJson(request: Request) {
  try {
    return (await request.json()) as unknown
  } catch {
    return null
  }
}
