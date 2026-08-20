import { sendOverSmtp, type SmtpSettings } from './smtp'

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
