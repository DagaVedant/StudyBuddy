import { createTransport } from 'nodemailer'


export interface MailMessage {
  to: string
  subject: string
  text: string
}

export interface MailSender {
  address: string
  name: string
}

const DEFAULT_HOST = 'smtp.gmail.com'

const DEFAULT_PORT = 465

export function mailSender(): MailSender | null {
  const address = process.env.MAIL_FROM?.trim()
  if (!address) return null

  return { address, name: process.env.MAIL_FROM_NAME?.trim() || 'StudyBuddy' }
}

export function smtpSettings(): SmtpSettings | null {
  const password = process.env.SMTP_PASSWORD?.trim()
  const user = process.env.SMTP_USER?.trim() || mailSender()?.address

  if (!password || !user) return null

  const port = Number(process.env.SMTP_PORT?.trim() || DEFAULT_PORT)

  return {
    host: process.env.SMTP_HOST?.trim() || DEFAULT_HOST,
    port: Number.isFinite(port) ? port : DEFAULT_PORT,
    user,
    password,
  }
}

export function mailConfigured(): boolean {
  return Boolean(mailSender() && smtpSettings())
}

export async function sendMail(message: MailMessage): Promise<void> {
  const sender = mailSender()
  const settings = smtpSettings()

  if (!sender || !settings) {
    console.warn(
      `[mail] not configured, so nothing was sent to ${message.to}. ` +
        `Set MAIL_FROM and SMTP_PASSWORD.`,
    )
    return
  }

  await sendOverSmtp(settings, sender, message)
}

const TIMEOUT_MS = 15_000

export interface SmtpSettings {
  host: string
  port: number
  user: string
  password: string
}

export async function sendOverSmtp(
  settings: SmtpSettings,
  sender: MailSender,
  message: MailMessage,
): Promise<void> {
  const transport = createTransport({
    host: settings.host,
    port: settings.port,

    secure: settings.port === 465,
    requireTLS: settings.port !== 465,

    auth: { user: settings.user, pass: settings.password },

    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  })

  try {
    await transport.sendMail({
      from: { address: sender.address, name: sender.name },
      to: message.to,
      subject: message.subject,
      text: message.text,
    })
  } finally {
    transport.close()
  }
}
export interface ErrorReport {
  message: string
  digest?: string
  path?: string
  method?: string
  routeType?: string
}

const REPORT_TIMEOUT_MS = 5_000

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
        signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
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
