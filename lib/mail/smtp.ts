import { createTransport } from 'nodemailer'

import type { MailMessage, MailSender } from './index'

const TIMEOUT_MS = 15_000

export interface SmtpSettings {
  host: string
  port: number
  user: string
  password: string
}

/**
 * SMTP rather than a transactional API, because every provider that has one
 * wants an account and a domain before it will send anything. Gmail asks for
 * neither: the account already exists, and an app password is a credential it
 * issues to itself. Any other SMTP host works from the same four settings.
 */
export async function sendOverSmtp(
  settings: SmtpSettings,
  sender: MailSender,
  message: MailMessage,
): Promise<void> {
  const transport = createTransport({
    host: settings.host,
    port: settings.port,

    // 465 is TLS from the first byte. Everything else starts in the clear and
    // upgrades, and must be refused if the upgrade is not on offer.
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
