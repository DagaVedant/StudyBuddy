import { timingSafeEqual } from 'node:crypto'

import { clientIp } from '@/lib/http/client-ip'

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

  /*
   * Unset is refused, not waved through.
   *
   * This used to read `if (allowed.length > 0)`, so an empty variable meant no
   * restriction: the allowlist degraded to nothing exactly when nobody had
   * configured it, which is the state every deployment starts in. `.env.example`
   * shipped it empty and the setup docs said to skip it, so the ordinary outcome was
   * a defence that was never on, and a leaked WORKER_API_TOKEN worked from
   * anywhere on the internet (finding 113).
   *
   * The token is still the real gate and this is defence in depth. What changed
   * is that switching the depth off is now a thing somebody chose and can be
   * read in the environment, rather than the default nobody noticed. `*` is
   * that choice, spelled out.
   */
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

    // Null, not a placeholder: a caller we cannot identify must not match an
    // allowlist entry.
    const ip = clientIp(request.headers)
    if (!ip || !allowed.includes(ip)) {
      return { ok: false, status: 403, message: 'Worker credential not valid from here.' }
    }
  }

  return { ok: true }
}
