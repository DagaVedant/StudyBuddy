import { sendWithBrevo } from './brevo'

export interface MailMessage {
  to: string
  subject: string
  text: string
}

export interface MailSender {
  address: string
  name: string
}

export function mailSender(): MailSender | null {
  const address = process.env.MAIL_FROM?.trim()
  if (!address) return null

  return { address, name: process.env.MAIL_FROM_NAME?.trim() || 'StudyBuddy' }
}

/**
 * Whether this deployment can send at all. A screen that offers to email
 * somebody checks first, because the alternative is telling a student a link
 * is on its way from a deployment that has no way to send one.
 */
export function mailConfigured(): boolean {
  return Boolean(mailSender() && process.env.BREVO_API_KEY?.trim())
}

export async function sendMail(message: MailMessage): Promise<void> {
  const sender = mailSender()
  const apiKey = process.env.BREVO_API_KEY?.trim()

  if (!sender || !apiKey) {
    console.warn(
      `[mail] not configured, so nothing was sent to ${message.to}. ` +
        `Set MAIL_FROM and BREVO_API_KEY.`,
    )
    return
  }

  await sendWithBrevo(apiKey, sender, message)
}
