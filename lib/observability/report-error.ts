export interface ErrorReport {
  message: string
  digest?: string
  path?: string
  method?: string
  routeType?: string
}

const TIMEOUT_MS = 5_000

/*
 * Errors already reach the platform log. What a log cannot do is tell
 * somebody, so this posts the same line to a webhook when one is configured:
 * ERROR_WEBHOOK_URL takes any endpoint that accepts a JSON body with a `text`
 * field, which is what Slack and Discord both do.
 *
 * It never throws. An error while reporting an error is the one thing that
 * must not take a request down with it.
 */
export async function reportError(report: ErrorReport): Promise<void> {
  const where = [report.method, report.path].filter(Boolean).join(' ')

  console.error(
    `[error] ${where || report.routeType || 'server'}: ${report.message}` +
      (report.digest ? ` (digest ${report.digest})` : ''),
  )

  const url = process.env.ERROR_WEBHOOK_URL?.trim()
  if (!url) return

  const site = process.env.NEXT_PUBLIC_APP_URL?.trim() || 'studybuddy'

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text:
          `StudyBuddy error on ${site}\n` +
          `${where || report.routeType || 'server'}\n` +
          `${report.message}${report.digest ? ` (digest ${report.digest})` : ''}`,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (cause) {
    console.error('[error] could not post the report:', (cause as Error).message)
  }
}
