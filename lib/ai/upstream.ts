/**
 * How long any one cloud call may take before it is abandoned.
 *
 * Ollama has had a timeout since it was written; the three cloud providers had
 * none at all, which matters more than it sounds. A cloud extraction runs
 * inside `after()` on the complete route, holding a database connection out of
 * a pool of five, and that route caps out at `maxDuration = 300`. An upstream
 * that accepts the request and then never answers used to pin a connection for
 * the whole five minutes and take the rest of the drain down with it.
 *
 * Two minutes is chosen against that budget rather than against how long a
 * model takes: it leaves the drain time to fail one page and still finish the
 * others. A page dense enough to genuinely need longer is better off failing
 * and being retried than blocking four other pages behind it.
 */
export const CLOUD_TIMEOUT_MS = 120_000

/**
 * An upstream refusal, translated for the person who will read it.
 *
 * The message on the error thrown here is not for a log. It travels through
 * `failJob` into `processing_jobs.error` and is rendered verbatim on the
 * worksheet status page, so whatever the provider put in its response body
 * lands on a student's screen: an echo of the request, an internal endpoint
 * name, a stack trace, or several kilobytes of JSON.
 *
 * The body is worth keeping, so it is logged. What the student gets instead is
 * the status, translated, because the status is the only part that tells them
 * which of the two things they can actually do: fix the key, or wait.
 */
export function upstreamFailure(label: string, status: number, body: string): Error {
  console.error(`[ai] ${label} responded ${status}: ${body.slice(0, 2000)}`)
  return new Error(describeStatus(label, status))
}

function describeStatus(label: string, status: number): string {
  if (status === 401 || status === 403) {
    return `${label} rejected the API key. Check it in settings.`
  }
  if (status === 402) {
    return `${label} reports this account is out of credit.`
  }
  if (status === 429) {
    return `${label} is rate limiting this key. Try again in a few minutes.`
  }
  if (status >= 500) {
    return `${label} is having trouble right now. Try again shortly.`
  }
  return `${label} rejected the request (HTTP ${status}).`
}

/**
 * A call that never got an answer: timed out, refused, DNS, TLS.
 *
 * Distinct from {@link upstreamFailure} because there is no status to
 * translate, and distinct from a bug because none of these are the student's
 * doing. The timeout gets its own wording since it is the one case where
 * trying the same thing again is genuinely worth doing.
 */
export function upstreamUnreachable(label: string, cause: unknown): Error {
  console.error(`[ai] ${label} call failed:`, cause)

  const name = (cause as { name?: unknown } | null | undefined)?.name
  const timedOut = typeof name === 'string' && /timeout/i.test(name)

  return new Error(
    timedOut
      ? `${label} did not answer within ${Math.round(CLOUD_TIMEOUT_MS / 1000)} seconds. Try again.`
      : `${label} could not be reached. Try again shortly.`,
  )
}
