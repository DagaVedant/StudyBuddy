import { timingSafeEqual } from 'node:crypto'

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export type CronAuth = { ok: true } | { ok: false; status: 401 | 403; message: string }

/**
 * Guards the routes Vercel Cron calls on a schedule (vercel.json), the same
 * shape `authenticateWorker` guards the GPU worker's polling with, but
 * against `CRON_SECRET` rather than `WORKER_API_TOKEN`.
 *
 * Vercel attaches `Authorization: Bearer $CRON_SECRET` to every
 * cron-triggered request once that variable is set on the project, which is
 * the platform's own recommended way to tell a scheduled invocation apart
 * from anyone who found the path. Cron dispatches from Vercel's own
 * infrastructure rather than a fixed address, so there is no IP to allowlist
 * the way the GPU worker's own static machine can be.
 */
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
