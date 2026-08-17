export const CLOUD_TIMEOUT_MS = 120_000

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
