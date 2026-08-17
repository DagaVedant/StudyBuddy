import type { MailMessage, MailSender } from './index'

const ENDPOINT = 'https://api.brevo.com/v3/smtp/email'

const TIMEOUT_MS = 10_000

/**
 * Brevo rather than Resend, because Resend will only send from a domain you
 * own. Brevo verifies a single sender address, so a personal mailbox works,
 * and the transactional API is one POST, so this needs no SDK.
 */
export async function sendWithBrevo(
  apiKey: string,
  sender: MailSender,
  message: MailMessage,
): Promise<void> {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { email: sender.address, name: sender.name },
      to: [{ email: message.to }],
      subject: message.subject,
      textContent: message.text,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')

    throw new Error(
      `Brevo refused the message (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`,
    )
  }
}
