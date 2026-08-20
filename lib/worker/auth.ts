import { timingSafeEqual } from 'node:crypto'

import { clientIp } from '@/lib/request'

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
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

  const configured = (process.env.WORKER_ALLOWED_IPS ?? '').trim()

  if (!configured) {
    return {
      ok: false,
      status: 403,
      message:
        'WORKER_ALLOWED_IPS is not set. List the worker addresses, or set it to * to allow any.',
    }
  }

  if (configured !== '*') {
    const allowed = configured
      .split(',')
      .map((ip) => ip.trim())
      .filter(Boolean)

    const ip = clientIp(request.headers)
    if (!ip || !allowed.includes(ip)) {
      return { ok: false, status: 403, message: 'Worker credential not valid from here.' }
    }
  }

  return { ok: true }
}
