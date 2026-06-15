import { timingSafeEqual } from 'node:crypto'

/**
 * Worker credential check (spec §8 threat model).
 *
 * The credential is scoped to claim-job + write-result only, and can be pinned
 * to the VPS exit node's IP (§3.3.1) so a stolen token is useless from
 * anywhere else.
 */

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function clientIp(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]!.trim()
  return request.headers.get('x-real-ip')
}

export type WorkerAuth =
  | { ok: true }
  | { ok: false; status: 401 | 403; message: string }

export function authenticateWorker(request: Request): WorkerAuth {
  const expected = process.env.WORKER_API_TOKEN
  if (!expected) {
    return { ok: false, status: 403, message: 'Worker API is not configured.' }
  }

  const header = request.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''

  if (!token || !safeEquals(token, expected)) {
    return { ok: false, status: 401, message: 'Bad worker credential.' }
  }

  // Optional IP pin. Empty means unrestricted, which is the local-dev default.
  const allowed = (process.env.WORKER_ALLOWED_IPS ?? '')
    .split(',')
    .map((ip) => ip.trim())
    .filter(Boolean)

  if (allowed.length > 0) {
    const ip = clientIp(request)
    if (!ip || !allowed.includes(ip)) {
      return { ok: false, status: 403, message: 'Worker credential not valid from here.' }
    }
  }

  return { ok: true }
}
