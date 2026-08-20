import { createTransport } from 'nodemailer'

import type { MailMessage, MailSender } from './index'

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
