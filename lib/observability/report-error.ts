import { mailConfigured, sendMail } from '@/lib/mail'

export interface ErrorReport {
  message: string
  digest?: string
  path?: string
  method?: string
  routeType?: string
}

const TIMEOUT_MS = 5_000

const REPEAT_WINDOW_MS = 10 * 60_000

const MAX_PER_HOUR = 12

const HOUR_MS = 3600_000

const lastSeen = new Map<string, number>()
let windowStartedAt = 0
let sentThisWindow = 0

function shouldSend(key: string, now: number): boolean {
  if (now - windowStartedAt > HOUR_MS) {
    windowStartedAt = now
    sentThisWindow = 0
  }

  if (sentThisWindow >= MAX_PER_HOUR) return false

  const seen = lastSeen.get(key)
  if (seen !== undefined && now - seen < REPEAT_WINDOW_MS) return false

  lastSeen.set(key, now)
  sentThisWindow += 1

  return true
}

export function resetAlertThrottle(): void {
  lastSeen.clear()
  windowStartedAt = 0
  sentThisWindow = 0
}

function describe(report: ErrorReport): string {
  const where = [report.method, report.path].filter(Boolean).join(' ')

  return `${where || report.routeType || 'server'}: ${report.message}${
    report.digest ? ` (digest ${report.digest})` : ''
  }`
}

export async function reportError(
  report: ErrorReport,
  now: number = Date.now(),
): Promise<void> {
  const line = describe(report)

  console.error(`[error] ${line}`)

  const url = process.env.ERROR_WEBHOOK_URL?.trim()
  const alertTo = process.env.ALERT_EMAIL?.trim()

  if (!url && !alertTo) return
  if (!shouldSend(report.message, now)) return

  const site = process.env.NEXT_PUBLIC_APP_URL?.trim() || 'studybuddy'
  const body = `StudyBuddy error on ${site}\n${line}`

  if (url) {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: body }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (cause) {
      console.error('[error] could not post the report:', (cause as Error).message)
    }
  }

  if (alertTo && mailConfigured()) {
    try {
      await sendMail({
        to: alertTo,
        subject: `StudyBuddy error: ${report.message.slice(0, 80)}`,
        text: `${body}\n\nThis is capped at one repeat every ten minutes and a dozen an hour.`,
      })
    } catch (cause) {
      console.error('[error] could not email the report:', (cause as Error).message)
    }
  }
}
