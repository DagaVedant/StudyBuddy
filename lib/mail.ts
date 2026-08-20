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
