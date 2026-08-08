/**
 * Best-effort caller IP, read the one way.
 *
 * Behind Vercel the left-most `x-forwarded-for` entry is the client, with
 * `x-real-ip` as the fallback. This lived twice — once in the worker auth, once
 * in the rate limiter — with the same header parsing and quietly different
 * answers when neither header is present, which is the case that actually
 * matters: one was making an allow/deny decision on it.
 *
 * Returns null rather than guessing. The two callers want opposite things from
 * that, and both now say so at the call site:
 *
 *   - the worker allowlist rejects, because an unidentifiable caller must not
 *     match an allowlist entry;
 *   - the rate limiter falls back to a shared bucket via {@link callerIp},
 *     because a missing header must not amount to no limit at all.
 */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  if (forwarded) return forwarded
  return headers.get('x-real-ip')?.trim() || null
}

/**
 * {@link clientIp}, degraded to one shared bucket when the headers say nothing.
 *
 * Noisy for the rare visitor with no header, but the alternative is a missing
 * header that trivially disables the limiter.
 */
export function callerIp(headers: Headers): string {
  return clientIp(headers) ?? 'unknown'
}
