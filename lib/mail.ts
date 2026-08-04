import { appBaseUrl } from '@/lib/app-url'

interface SendArgs {
  to: string
  subject: string
  text: string
}

async function send({ to, subject, text }: SendArgs): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.EMAIL_FROM ?? 'StudyBuddy <onboarding@resend.dev>'

  if (!apiKey) {
    console.warn(
      `[mail] RESEND_API_KEY not set — logging instead of sending.\n` +
        `  to: ${to}\n  subject: ${subject}\n\n${text}\n`,
    )
    return
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, text }),
  })

  if (!response.ok) {
    throw new Error(`Resend responded ${response.status}: ${await response.text()}`)
  }
}

export async function sendVerificationEmail(email: string, token: string) {
  const url = `${appBaseUrl()}/verify?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`

  await send({
    to: email,
    subject: 'Verify your StudyBuddy account',
    text: `Confirm your email address to finish setting up StudyBuddy:\n\n${url}\n\nThis link expires in 24 hours. If you didn't create an account, ignore this message.`,
  })
}
